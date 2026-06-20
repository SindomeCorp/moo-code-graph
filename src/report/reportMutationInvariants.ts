import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import type { ExtractedObjectRecord, ExtractedPropertyDefinitionRecord, ExtractedPropertyValueRecord } from "@sindomecorp/toaststunt-db-extractor";
import type { AssignmentFact } from "../facts/types.js";
import { readJsonl } from "../load/JsonlReader.js";
import { loadObjects } from "../load/loadObjects.js";
import { loadProperties } from "../load/loadProperties.js";
import type { PropertyCandidateEdge } from "../resolve/types.js";
import { defaultReportConfig, type MutationInvariantReportConfig } from "./reportConfig.js";

export type MutationInvariantBucket = "shape_mismatch" | "object_scalar_mismatch" | "collection_shape_mismatch" | "sensitive_shape_mismatch";
export type ValueShape = "string" | "int" | "float" | "object" | "object_list" | "list" | "map" | "error" | "unknown";

export interface ReportMutationInvariantsOptions {
  resolvedDir: string;
  examplesPerBucket?: number;
  config?: MutationInvariantReportConfig;
}

export interface MutationInvariantFinding {
  domain: "mutation_invariants";
  bucket: MutationInvariantBucket;
  reason: string;
  confidence: "high";
  sensitive: boolean;
  refKind: "property_write";
  ref: string;
  sourceVerbId: string;
  sourceVerbName?: string;
  sourceObject: string;
  sourcePath: string;
  sourceLine?: string;
  line: number;
  column: number;
  targetObject: string;
  definedOn: string;
  property: string;
  propertyId: string;
  receiverRaw: string;
  effectiveValueObject: string;
  effectiveValueSource: "direct" | "inherited";
  effectiveValuePreview: string;
  dbShape: ValueShape;
  rhsShape: ValueShape;
  rightText: string;
}

export interface MutationInvariantBucketSummary {
  bucket: MutationInvariantBucket;
  count: number;
  examples: MutationInvariantFinding[];
}

export interface MutationInvariantsReport {
  resolvedDir: string;
  graphDir: string;
  sourceExtractDir?: string;
  examplesPerBucket: number;
  totalWriteCount: number;
  analyzedWriteCount: number;
  total: number;
  buckets: MutationInvariantBucketSummary[];
}

interface EffectiveValue {
  object: string;
  source: "direct" | "inherited";
  shape: ValueShape;
  preview: string;
  owner?: string;
}

const buckets: MutationInvariantBucket[] = ["sensitive_shape_mismatch", "object_scalar_mismatch", "collection_shape_mismatch", "shape_mismatch"];
const scalarShapes = new Set<ValueShape>(["string", "int", "float", "error"]);
const objectShapes = new Set<ValueShape>(["object"]);
const objectScalarShapes = new Set<ValueShape>(["object", "object_list"]);
const collectionShapes = new Set<ValueShape>(["list", "object_list", "map"]);
const sensitivePropertyPattern = /(?:wizard|owner|permissions|task|queue|enabled|key|password|token|quota|lock|config|options)/i;

export async function reportMutationInvariants(options: ReportMutationInvariantsOptions): Promise<MutationInvariantsReport> {
  const manifest = await readManifest(options.resolvedDir);
  const graphDir = graphDirFromManifest(options.resolvedDir, manifest);
  const sourceExtractDir = typeof manifest.sourceExtractDir === "string" ? resolve(manifest.sourceExtractDir) : undefined;
  const config = options.config ?? defaultReportConfig.reports.mutationInvariants;
  const examplesPerBucket = options.examplesPerBucket ?? 25;
  if (!config.enabled || !sourceExtractDir) {
    return emptyReport(options.resolvedDir, graphDir, sourceExtractDir, examplesPerBucket);
  }

  const writeEdges = (await readJsonl<PropertyCandidateEdge>(join(options.resolvedDir, "edges", "property_candidate_edges.jsonl"))).filter(
    (edge) => edge.accessKind === "write" && edge.property && edge.targetObject && edge.definedOn !== undefined
  );
  const assignments = await readFactFile<AssignmentFact>(graphDir, "assignments.jsonl");
  const objects = await loadObjects(sourceExtractDir);
  const properties = await loadPropertiesIfExists(sourceExtractDir);
  const sourceLines = await loadSourceLinesForWrites(sourceExtractDir, writeEdges);
  const objectById = new Map(objects.map((object) => [object.id, object]));
  const propertyDefinitionById = new Map(properties.map((property) => [property.id, property]));
  const coreObjects = await loadCoreObjects(sourceExtractDir);
  const valueKeys = neededValueKeys(writeEdges, objectById);
  const values = await loadNeededPropertyValues(sourceExtractDir, valueKeys);
  const assignmentByWrite = matchAssignments(writeEdges, assignments);
  const findings: MutationInvariantFinding[] = [];

  for (const edge of writeEdges) {
    if (config.ignoreSourceVerbs.includes(edge.sourceVerbId)) continue;
    if (isIgnoredProperty(config.ignoreProperties, edge.targetObject, edge.property)) continue;
    const assignment = assignmentByWrite.get(writeKey(edge));
    if (!assignment) continue;
    const rhsShape = classifyRhsShape(assignment.rightText);
    if (rhsShape === "unknown") continue;
    const effective = effectivePropertyValue(edge.targetObject, edge.property, objectById, values);
    if (!effective || effective.shape === "unknown") continue;
    const mismatch = mismatchBucket(effective.shape, rhsShape);
    if (!mismatch) continue;
    const sensitive = isSensitive(edge, effective, objectById, propertyDefinitionById, coreObjects);
    const bucket: MutationInvariantBucket = sensitive ? "sensitive_shape_mismatch" : mismatch;
    if (config.ignoreBuckets.includes(bucket)) continue;
    findings.push({
      domain: "mutation_invariants",
      bucket,
      reason: bucket,
      confidence: "high",
      sensitive,
      refKind: "property_write",
      ref: `${edge.receiverRaw}.${edge.property}`,
      sourceVerbId: edge.sourceVerbId,
      ...(edge.sourceVerbName ? { sourceVerbName: edge.sourceVerbName } : {}),
      sourceObject: edge.sourceObject,
      sourcePath: edge.sourcePath,
      ...(sourceLines.get(sourceLineKey(edge.sourcePath, edge.line)) ? { sourceLine: sourceLines.get(sourceLineKey(edge.sourcePath, edge.line)) } : {}),
      line: edge.line,
      column: edge.column,
      targetObject: edge.targetObject,
      definedOn: edge.definedOn,
      property: edge.property,
      propertyId: edge.propertyId,
      receiverRaw: edge.receiverRaw,
      effectiveValueObject: effective.object,
      effectiveValueSource: effective.source,
      effectiveValuePreview: effective.preview,
      dbShape: effective.shape,
      rhsShape,
      rightText: assignment.rightText
    });
  }

  const sorted = findings.sort(compareFindings);
  return {
    resolvedDir: options.resolvedDir,
    graphDir,
    sourceExtractDir,
    examplesPerBucket,
    totalWriteCount: writeEdges.length,
    analyzedWriteCount: sorted.length,
    total: sorted.length,
    buckets: summarizeBuckets(sorted, examplesPerBucket)
  };
}

export function formatMutationInvariantsReport(report: MutationInvariantsReport): string {
  const lines = [`Mutation / Invariants: ${report.total}`, `  resolved property writes: ${report.totalWriteCount}`];
  for (const bucket of report.buckets) {
    if (bucket.count === 0) continue;
    lines.push("");
    lines.push(`${bucket.bucket}: ${bucket.count}`);
    for (const finding of bucket.examples) {
      lines.push(
        `  ${finding.sourcePath}:${finding.line}:${finding.column} ${finding.ref} target=${finding.targetObject}.${finding.property} db=${finding.dbShape} current=${finding.effectiveValuePreview} rhs=${finding.rhsShape} valueFrom=${finding.effectiveValueObject} right=${finding.rightText}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function classifyRhsShape(text: string): ValueShape {
  const value = text.trim();
  if (!value) return "unknown";
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return "string";
  if (/^#-?\d+$/.test(value)) return "object";
  if (/^E_[A-Z][A-Z0-9_]*$/.test(value)) return "error";
  if (/^[+-]?\d+$/.test(value)) return "int";
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || /^[+-]?\d+[eE][+-]?\d+$/.test(value)) return "float";
  if (/^\{[\s\S]*\}$/.test(value)) return "list";
  if (/^\[[\s\S]*->[\s\S]*\]$/.test(value)) return "map";
  return "unknown";
}

export function effectivePropertyValue(
  targetObject: string,
  property: string,
  objectById: Map<string, { parents?: string[] }>,
  values: Map<string, { owner?: string | null; value?: unknown }>
): EffectiveValue | undefined {
  const visited = new Set<string>();
  const queue: Array<{ object: string; source: "direct" | "inherited" }> = [{ object: targetObject, source: "direct" }];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current.object)) continue;
    visited.add(current.object);
    const row = values.get(valueKey(current.object, property));
    if (row) {
      const shape = dbValueShape(row.value);
      if (shape !== "unknown") {
        if (shape !== "clear") {
          return {
            object: current.object,
            source: current.source,
            shape,
            preview: previewPropertyValue(row.value),
            ...(row.owner ? { owner: row.owner } : {})
          };
        }
      }
    }
    const object = objectById.get(current.object);
    for (const parent of object?.parents ?? []) {
      if (parent === "#-1") continue;
      queue.push({ object: parent, source: "inherited" });
    }
  }
  return undefined;
}

function mismatchBucket(dbShape: ValueShape, rhsShape: ValueShape): Exclude<MutationInvariantBucket, "sensitive_shape_mismatch"> | undefined {
  if (dbShape === rhsShape || equivalentListShape(dbShape, rhsShape)) return undefined;
  if ((objectScalarShapes.has(dbShape) && scalarShapes.has(rhsShape)) || (scalarShapes.has(dbShape) && objectScalarShapes.has(rhsShape))) return "object_scalar_mismatch";
  if ((objectShapes.has(dbShape) && scalarShapes.has(rhsShape)) || (scalarShapes.has(dbShape) && objectShapes.has(rhsShape))) return "object_scalar_mismatch";
  if (collectionShapes.has(dbShape) && collectionShapes.has(rhsShape) && dbShape !== rhsShape) return "collection_shape_mismatch";
  if ((collectionShapes.has(dbShape) && !collectionShapes.has(rhsShape)) || (!collectionShapes.has(dbShape) && collectionShapes.has(rhsShape))) return "collection_shape_mismatch";
  return "shape_mismatch";
}

function equivalentListShape(left: ValueShape, right: ValueShape): boolean {
  return (left === "list" && right === "object_list") || (left === "object_list" && right === "list");
}

function dbValueShape(value: unknown): ValueShape | "clear" {
  if (!value || typeof value !== "object") return "unknown";
  const record = value as { type?: unknown; objectRefs?: unknown };
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type === "clear") return "clear";
  if (type === "string") return "string";
  if (type === "int" || type === "integer") return "int";
  if (type === "float" || type === "real") return "float";
  if (type === "object") return "object";
  if (type === "error") return "error";
  if (type === "map") return "map";
  if (type === "list") return Array.isArray(record.objectRefs) && record.objectRefs.length > 0 ? "object_list" : "list";
  return "unknown";
}

function previewPropertyValue(value: unknown): string {
  return truncatePreview(previewValue(value, 0), 180);
}

function previewValue(value: unknown, depth: number): string {
  if (!value || typeof value !== "object") return "unknown";
  if (depth > 2) return "...";
  const record = value as {
    type?: unknown;
    value?: unknown;
    object?: unknown;
    items?: unknown;
    entries?: unknown;
    objectRefs?: unknown;
    truncated?: unknown;
    redacted?: unknown;
  };
  if (record.redacted) return "<redacted>";
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type === "clear") return "<clear>";
  if (type === "string") return JSON.stringify(String(record.value ?? ""));
  if (type === "int" || type === "integer" || type === "float" || type === "real") return String(record.value ?? "");
  if (type === "object") return typeof record.object === "string" ? record.object : "object";
  if (type === "error") return String(record.value ?? "E_?");
  if (type === "list") {
    const items = Array.isArray(record.items) ? record.items : Array.isArray(record.objectRefs) ? record.objectRefs.map((object) => ({ type: "object", object })) : [];
    return `{${previewItems(items, depth)}}`;
  }
  if (type === "map") {
    const entries = Array.isArray(record.entries) ? record.entries.slice(0, 6) : [];
    const rendered = entries.map((entry) => {
      const pair = entry as { key?: unknown; value?: unknown };
      return `${previewValue(pair.key, depth + 1)} -> ${previewValue(pair.value, depth + 1)}`;
    });
    if (Array.isArray(record.entries) && record.entries.length > entries.length) rendered.push("...");
    return `[${rendered.join(", ")}]`;
  }
  return type || "unknown";
}

function previewItems(items: unknown[], depth: number): string {
  const visible = items.slice(0, 8).map((item) => previewValue(item, depth + 1));
  if (items.length > visible.length) visible.push("...");
  return visible.join(", ");
}

function truncatePreview(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function isSensitive(
  edge: PropertyCandidateEdge,
  effective: EffectiveValue,
  objectById: Map<string, ExtractedObjectRecord>,
  propertyDefinitionById: Map<string, ExtractedPropertyDefinitionRecord>,
  coreObjects: Set<string>
): boolean {
  if (edge.targetObject === "#0") return true;
  if (coreObjects.has(edge.targetObject) || coreObjects.has(edge.definedOn)) return true;
  if (edge.definedOn === "builtin" || edge.resolutionKind === "built_in_property") return true;
  if (edge.definedOn !== edge.targetObject || effective.source === "inherited") return true;
  if (sensitivePropertyPattern.test(edge.property)) return true;
  const sourceOwner = objectById.get(edge.sourceObject)?.owner;
  const propertyOwner = effective.owner ?? propertyDefinitionById.get(edge.propertyId)?.object;
  return Boolean(sourceOwner && propertyOwner && sourceOwner !== propertyOwner);
}

function matchAssignments(edges: PropertyCandidateEdge[], assignments: AssignmentFact[]): Map<string, AssignmentFact> {
  const assignmentsBySourceLine = new Map<string, AssignmentFact[]>();
  for (const assignment of assignments) {
    const key = `${assignment.sourceVerbId}:${assignment.line}`;
    assignmentsBySourceLine.set(key, [...(assignmentsBySourceLine.get(key) ?? []), assignment]);
  }
  const result = new Map<string, AssignmentFact>();
  for (const edge of edges) {
    const candidates = (assignmentsBySourceLine.get(`${edge.sourceVerbId}:${edge.line}`) ?? []).filter((assignment) => leftMatchesEdge(assignment.leftText, edge));
    if (candidates.length === 1) result.set(writeKey(edge), candidates[0]!);
  }
  return result;
}

function leftMatchesEdge(leftText: string, edge: PropertyCandidateEdge): boolean {
  const left = normalizeMooText(leftText);
  const receiver = normalizeMooText(edge.receiverRaw);
  const property = normalizeMooText(edge.property);
  return left === `${receiver}.${property}` || left === `${receiver}.(${property})`;
}

function neededValueKeys(edges: PropertyCandidateEdge[], objectById: Map<string, ExtractedObjectRecord>): Set<string> {
  const keys = new Set<string>();
  for (const edge of edges) {
    const visited = new Set<string>();
    const queue = [edge.targetObject];
    while (queue.length) {
      const objectId = queue.shift()!;
      if (visited.has(objectId)) continue;
      visited.add(objectId);
      keys.add(valueKey(objectId, edge.property));
      for (const parent of objectById.get(objectId)?.parents ?? []) {
        if (parent !== "#-1") queue.push(parent);
      }
    }
  }
  return keys;
}

async function loadNeededPropertyValues(extractDir: string, neededKeys: Set<string>): Promise<Map<string, ExtractedPropertyValueRecord>> {
  const path = join(extractDir, "property_values.jsonl");
  const rows = new Map<string, ExtractedPropertyValueRecord>();
  if (!existsSync(path) || neededKeys.size === 0) return rows;
  const reader = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const rawLine of reader) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) continue;
    let row: ExtractedPropertyValueRecord;
    try {
      row = JSON.parse(line) as ExtractedPropertyValueRecord;
    } catch (cause) {
      throw new Error(`Invalid JSONL in ${path} at line ${lineNumber}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (!row.name) continue;
    const key = valueKey(row.object, row.name);
    if (neededKeys.has(key)) rows.set(key, row);
  }
  return rows;
}

async function loadSourceLinesForWrites(extractDir: string, edges: PropertyCandidateEdge[]): Promise<Map<string, string>> {
  const paths = new Map<string, Set<number>>();
  for (const edge of edges) {
    const lines = paths.get(edge.sourcePath) ?? new Set<number>();
    lines.add(edge.line);
    paths.set(edge.sourcePath, lines);
  }
  const result = new Map<string, string>();
  await Promise.all(
    [...paths.entries()].map(async ([sourcePath, lines]) => {
      try {
        const source = await readFile(join(extractDir, sourcePath), "utf8");
        const sourceLines = source.split(/\r?\n/);
        for (const line of lines) {
          if (sourceLines[line] !== undefined) result.set(sourceLineKey(sourcePath, line), sourceLines[line]!);
        }
      } catch {
        // Source snippets are helpful, but absence should not suppress findings.
      }
    })
  );
  return result;
}

function summarizeBuckets(findings: MutationInvariantFinding[], examplesPerBucket: number): MutationInvariantBucketSummary[] {
  return buckets.map((bucket) => {
    const rows = findings.filter((finding) => finding.bucket === bucket);
    return { bucket, count: rows.length, examples: rows.slice(0, examplesPerBucket) };
  });
}

function compareFindings(left: MutationInvariantFinding, right: MutationInvariantFinding): number {
  return buckets.indexOf(left.bucket) - buckets.indexOf(right.bucket) || left.sourcePath.localeCompare(right.sourcePath) || left.line - right.line || left.column - right.column;
}

function isIgnoredProperty(patterns: string[], objectId: string, property: string): boolean {
  const full = `${objectId}.${property}`;
  const suffix = `*.${property}`;
  return patterns.some((pattern) => pattern === full || pattern === suffix);
}

async function readManifest(resolvedDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(resolvedDir, "manifest.json"), "utf8")) as Record<string, unknown>;
}

async function readFactFile<T>(graphDir: string, fileName: string): Promise<T[]> {
  const path = join(graphDir, "code_facts", fileName);
  if (!existsSync(path)) return [];
  return readJsonl<T>(path);
}

function graphDirFromManifest(resolvedDir: string, manifest: Record<string, unknown>): string {
  if (typeof manifest.sourceGraphDir === "string") return resolve(manifest.sourceGraphDir);
  return resolve(join(resolvedDir, "..", "graph"));
}

async function loadPropertiesIfExists(extractDir: string): Promise<ExtractedPropertyDefinitionRecord[]> {
  if (!existsSync(join(extractDir, "properties.jsonl"))) return [];
  return readJsonl<ExtractedPropertyDefinitionRecord>(join(extractDir, "properties.jsonl"));
}

async function loadCoreObjects(extractDir: string): Promise<Set<string>> {
  const path = join(extractDir, "core_candidates.jsonl");
  const objects = new Set<string>();
  if (!existsSync(path)) return objects;
  const rows = await readJsonl<{ targetObject?: string }>(path);
  for (const row of rows) {
    if (row.targetObject) objects.add(row.targetObject);
  }
  return objects;
}

function emptyReport(resolvedDir: string, graphDir: string, sourceExtractDir: string | undefined, examplesPerBucket: number): MutationInvariantsReport {
  return {
    resolvedDir,
    graphDir,
    ...(sourceExtractDir ? { sourceExtractDir } : {}),
    examplesPerBucket,
    totalWriteCount: 0,
    analyzedWriteCount: 0,
    total: 0,
    buckets: summarizeBuckets([], examplesPerBucket)
  };
}

function normalizeMooText(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function valueKey(object: string, property: string): string {
  return `${object}\u0000${property.toLowerCase()}`;
}

function writeKey(edge: PropertyCandidateEdge): string {
  return `${edge.sourceVerbId}:${edge.line}:${edge.column}:${edge.receiverRaw}.${edge.property}`;
}

function sourceLineKey(sourcePath: string, line: number): string {
  return `${sourcePath}\u0000${line}`;
}
