import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface AuditIssue {
  file: string;
  line?: number;
  message: string;
}

const resolvedDir = resolve(process.argv[2] ?? "");

if (!process.argv[2]) {
  console.error("Usage: npm run audit:resolved -- <resolved-dir>");
  process.exit(2);
}

const edgeFiles = {
  systemObjectEdges: "edges/system_object_edges.jsonl",
  rootPropertyEdges: "edges/root_property_edges.jsonl",
  rootVerbCallEdges: "edges/root_verb_call_edges.jsonl",
  literalObjectEdges: "edges/literal_object_edges.jsonl",
  verbCallCandidateEdges: "edges/verb_call_candidate_edges.jsonl",
  propertyCandidateEdges: "edges/property_candidate_edges.jsonl",
  guardedPropertyAccessEdges: "edges/guarded_property_access_edges.jsonl",
  unresolvedRefs: "edges/unresolved_refs.jsonl",
  unresolvedVerbCallFindings: "findings/unresolved_verb_calls.jsonl",
  unresolvedPropertyAccessFindings: "findings/unresolved_property_accesses.jsonl",
  localVariableStates: "flow/local_variable_states.jsonl",
  inferredReceiverCandidates: "flow/inferred_receiver_candidates.jsonl"
} as const;

const issues: AuditIssue[] = [];
const counts: Record<string, number> = {};
const seenCandidateEdges = new Set<string>();
let currentFile = "";
let currentLine = 0;

async function main(): Promise<void> {
  requireFile("manifest.json");
  requireFile("edges/stats.json");
  for (const file of Object.values(edgeFiles)) requireFile(file);

  const manifest = await readJson(join(resolvedDir, "manifest.json"));
  const source = await loadSourceIndexes(manifest);
  const stats = await readJson(join(resolvedDir, "edges/stats.json"));

  await auditJsonl(edgeFiles.systemObjectEdges, (row) => {
    requireKind(row, "system_object_edge");
    requireSource(row);
    requireString(row, "symbol");
    requireString(row, "targetObject");
    requireString(row, "resolutionKind");
    requireString(row, "confidence");
    requireString(row, "context");
    validateSourceReference(row, source);
    validateObjectField(row, "targetObject", source);
  });

  await auditJsonl(edgeFiles.rootPropertyEdges, (row) => {
    requireKind(row, "root_property_edge");
    requireSource(row);
    requireString(row, "sourceVerbName");
    requireString(row, "symbol");
    requireString(row, "property");
    requireString(row, "targetObject");
    requireString(row, "definedOn");
    requireString(row, "propertyId");
    requireOptionalNumber(row, "definitionIndex");
    requireString(row, "accessKind");
    requireString(row, "resolutionKind");
    requireString(row, "confidence");
    requireString(row, "context");
    validateSourceReference(row, source);
    validateObjectField(row, "targetObject", source);
    validateObjectField(row, "definedOn", source);
    validatePropertyField(row, "propertyId", source);
  });

  await auditJsonl(edgeFiles.rootVerbCallEdges, (row) => {
    requireKind(row, "root_verb_call_edge");
    requireSource(row);
    requireString(row, "sourceVerbName");
    requireString(row, "function");
    requireString(row, "selector");
    requireString(row, "argumentsText");
    requireString(row, "targetObject");
    requireString(row, "definedOn");
    requireNumber(row, "inheritanceDepth");
    requireStringArray(row, "inheritancePath");
    validateInheritancePath({ ...row, receiverObject: row.targetObject });
    requireString(row, "targetVerbId");
    requireString(row, "resolutionKind");
    requireString(row, "confidence");
    validateSourceReference(row, source);
    validateObjectField(row, "targetObject", source);
    validateObjectField(row, "definedOn", source);
    validateVerbField(row, "targetVerbId", source);
    validateDuplicateCandidate(row);
  });

  await auditJsonl(edgeFiles.literalObjectEdges, (row) => {
    requireKind(row, "literal_object_edge");
    requireSource(row);
    requireString(row, "object");
    requireString(row, "targetObject");
    requireString(row, "resolutionKind");
    requireOptionalString(row, "specialName");
    requireString(row, "context");
    validateSourceReference(row, source);
    if (row.resolutionKind === "special_literal_object") {
      validateSpecialLiteralObject(row);
    } else {
      validateObjectField(row, "targetObject", source);
    }
  });

  await auditJsonl(edgeFiles.verbCallCandidateEdges, (row) => {
    requireKind(row, "verb_call_candidate_edge");
    requireSource(row);
    requireString(row, "sourceVerbName");
    requireString(row, "receiverKind");
    requireString(row, "receiverRaw");
    requireString(row, "receiverObject");
    requireString(row, "selector");
    requireString(row, "targetObject");
    requireString(row, "definedOn");
    requireNumber(row, "inheritanceDepth");
    requireStringArray(row, "inheritancePath");
    validateInheritancePath(row);
    requireString(row, "targetVerbId");
    requireString(row, "resolutionKind");
    requireString(row, "confidence");
    validateSourceReference(row, source);
    validateObjectField(row, "receiverObject", source);
    validateObjectField(row, "targetObject", source);
    validateObjectField(row, "definedOn", source);
    validateVerbField(row, "targetVerbId", source);
    validateDuplicateCandidate(row);
  });

  await auditJsonl(edgeFiles.propertyCandidateEdges, (row) => {
    requireKind(row, "property_candidate_edge");
    requireSource(row);
    requireString(row, "sourceVerbName");
    requireNumber(row, "line");
    requireNumber(row, "column");
    requireString(row, "accessKind");
    requireString(row, "receiverKind");
    requireString(row, "receiverRaw");
    requireString(row, "receiverObject");
    requireString(row, "property");
    requireString(row, "targetObject");
    requireString(row, "definedOn");
    requireNumber(row, "inheritanceDepth");
    requireStringArray(row, "inheritancePath");
    validateInheritancePath(row);
    requireString(row, "propertyId");
    requireString(row, "resolutionKind");
    requireString(row, "confidence");
    validateSourceReference(row, source);
    validateObjectField(row, "receiverObject", source);
    validateObjectField(row, "targetObject", source);
    validateObjectField(row, "definedOn", source, { allowBuiltin: true });
    validatePropertyField(row, "propertyId", source);
    validateDuplicateCandidate(row);
  });

  await auditJsonl(edgeFiles.guardedPropertyAccessEdges, (row) => {
    requireKind(row, "guarded_property_access_edge");
    requireSource(row);
    requireString(row, "sourceVerbName");
    requireString(row, "accessKind");
    requireString(row, "receiverKind");
    requireString(row, "receiverRaw");
    requireOptionalString(row, "receiverObject");
    requireString(row, "property");
    requireString(row, "ref");
    requireString(row, "guardText");
    requireString(row, "guardScope");
    requireString(row, "resolutionKind");
    requireString(row, "confidence");
    validateSourceReference(row, source);
    validateObjectField(row, "receiverObject", source);
  });

  await auditJsonl(edgeFiles.unresolvedRefs, (row) => {
    requireKind(row, "unresolved_ref");
    requireSource(row);
    requireString(row, "sourceVerbName");
    requireString(row, "refKind");
    requireString(row, "ref");
    requireString(row, "reason");
    requireOptionalString(row, "context");
    requireOptionalString(row, "receiverRaw");
    requireOptionalString(row, "receiverObject");
    requireOptionalString(row, "selector");
    requireOptionalString(row, "selectorExpression");
    validateSourceReference(row, source);
  });

  await auditJsonl(edgeFiles.unresolvedVerbCallFindings, (row) => {
    requireKind(row, "unresolved_verb_call");
    requireSource(row);
    requireString(row, "sourceVerbName");
    requireString(row, "severity");
    requireString(row, "ref");
    requireString(row, "reason");
    requireOptionalString(row, "sourceLine");
    requireOptionalString(row, "receiverRaw");
    requireOptionalString(row, "receiverObject");
    requireOptionalString(row, "selector");
    requireOptionalString(row, "selectorExpression");
    validateSourceReference(row, source);
  });

  await auditJsonl(edgeFiles.unresolvedPropertyAccessFindings, (row) => {
    requireKind(row, "unresolved_property_access");
    requireSource(row);
    requireString(row, "sourceVerbName");
    requireString(row, "severity");
    requireString(row, "ref");
    requireString(row, "reason");
    requireString(row, "accessKind");
    requireString(row, "receiverKind");
    requireString(row, "receiverRaw");
    requireOptionalString(row, "sourceLine");
    requireOptionalString(row, "receiverObject");
    requireOptionalString(row, "property");
    requireOptionalString(row, "propertyExpression");
    validateSourceReference(row, source);
  });

  await auditJsonl(edgeFiles.localVariableStates, (row) => {
    requireKind(row, "local_variable_state");
    requireSource(row);
    requireString(row, "variable");
    requireString(row, "valueKind");
    requireString(row, "provenance");
    requireString(row, "confidence");
    requireOptionalString(row, "reason");
    requireOptionalString(row, "sourceText");
    requireOptionalStringArray(row, "objects");
    requireOptionalString(row, "controlFlowKind");
    requireOptionalNumber(row, "controlFlowDepth");
    requireOptionalStringArray(row, "controlFlowPath");
    validateSourceReference(row, source);
    validateObjectArrayField(row, "objects", source);
  });

  await auditJsonl(edgeFiles.inferredReceiverCandidates, (row) => {
    requireKind(row, "inferred_receiver_candidate");
    requireSource(row);
    requireString(row, "useKind");
    requireString(row, "variable");
    requireString(row, "receiverRaw");
    requireString(row, "valueKind");
    requireString(row, "provenance");
    requireString(row, "confidence");
    requireOptionalString(row, "reason");
    requireOptionalString(row, "sourceText");
    requireOptionalStringArray(row, "objects");
    requireOptionalString(row, "controlFlowKind");
    requireOptionalNumber(row, "controlFlowDepth");
    requireOptionalStringArray(row, "controlFlowPath");
    validateSourceReference(row, source);
    validateObjectArrayField(row, "objects", source);
  });

  compareCount(stats, "resolvedSystemObjectRefCount", edgeFiles.systemObjectEdges);
  compareCount(stats, "resolvedRootPropertyRefCount", edgeFiles.rootPropertyEdges);
  compareCount(stats, "resolvedRootVerbFunctionCallCount", edgeFiles.rootVerbCallEdges);
  compareCount(stats, "resolvedLiteralObjectRefCount", edgeFiles.literalObjectEdges);
  compareCount(stats, "resolvedVerbCallCandidateCount", edgeFiles.verbCallCandidateEdges);
  compareCount(stats, "resolvedPropertyCandidateCount", edgeFiles.propertyCandidateEdges);
  compareCount(stats, "guardedPropertyAccessCount", edgeFiles.guardedPropertyAccessEdges);
  compareCountValue(
    Number(stats.unresolvedVerbCallCandidateCount ?? 0) + Number(stats.unresolvedRootVerbFunctionCallCount ?? 0),
    edgeFiles.unresolvedVerbCallFindings,
    "unresolved verb call findings"
  );
  compareCount(stats, "unresolvedPropertyAccessCount", edgeFiles.unresolvedPropertyAccessFindings);
  compareCount(stats, "localVariableStateCount", edgeFiles.localVariableStates);
  compareCount(stats, "inferredReceiverCandidateCount", edgeFiles.inferredReceiverCandidates);
  const unresolvedTotal = counts[edgeFiles.unresolvedRefs] ?? 0;
  const expectedUnresolved =
    Number(stats.unresolvedSystemObjectRefCount ?? 0) +
    Number(stats.unresolvedLiteralObjectRefCount ?? 0) +
    Number(stats.unresolvedVerbCallCandidateCount ?? 0) +
    Number(stats.unresolvedRootVerbFunctionCallCount ?? 0);
  if (unresolvedTotal !== expectedUnresolved) {
    issues.push({ file: "edges/stats.json", message: `unresolved refs are ${unresolvedTotal}, expected ${expectedUnresolved}` });
  }

  const report = { resolvedDir, counts, stats, issueCount: issues.length };
  console.log(JSON.stringify(report, null, 2));
  if (issues.length > 0) {
    for (const issue of issues.slice(0, 50)) {
      console.error(`${issue.file}${issue.line !== undefined ? `:${issue.line}` : ""}: ${issue.message}`);
    }
    process.exit(1);
  }
}

async function auditJsonl(relativePath: string, audit: (row: Record<string, unknown>) => void): Promise<void> {
  currentFile = relativePath;
  const rows = await readJsonl(join(resolvedDir, relativePath));
  counts[relativePath] = rows.length;
  for (let index = 0; index < rows.length; index += 1) {
    currentLine = index + 1;
    audit(rows[index]!);
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function loadSourceIndexes(manifest: Record<string, unknown>): Promise<{
  objectIds: Set<string>;
  verbIds: Set<string>;
  propertyIds: Set<string>;
}> {
  if (typeof manifest.sourceExtractDir !== "string" || manifest.sourceExtractDir === "") {
    issues.push({ file: "manifest.json", message: "Missing sourceExtractDir; source-aware edge audit is disabled" });
    return { objectIds: new Set(), verbIds: new Set(), propertyIds: new Set() };
  }

  const extractDir = resolve(manifest.sourceExtractDir);
  const objectRows = await readJsonl(join(extractDir, "objects.jsonl"));
  const verbRows = await readJsonl(join(extractDir, "verbs.jsonl"));
  const propertyRows = await readJsonl(join(extractDir, "properties.jsonl"));
  return {
    objectIds: new Set(objectRows.map((row) => row.id).filter((id): id is string => typeof id === "string")),
    verbIds: new Set(verbRows.map((row) => row.id).filter((id): id is string => typeof id === "string")),
    propertyIds: new Set(propertyRows.map((row) => row.id).filter((id): id is string => typeof id === "string"))
  };
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch (cause) {
        issues.push({ file: path, line: index + 1, message: cause instanceof Error ? cause.message : String(cause) });
        return {};
      }
    });
}

function requireFile(relativePath: string): void {
  if (!existsSync(join(resolvedDir, relativePath))) {
    issues.push({ file: relativePath, message: "Missing required resolved output file" });
  }
}

function requireKind(row: Record<string, unknown>, kind: string): void {
  if (row.kind !== kind) {
    issues.push({ file: currentFile, line: currentLine, message: `Expected kind ${kind}, got ${String(row.kind)}` });
  }
}

function requireSource(row: Record<string, unknown>): void {
  requireString(row, "sourceVerbId");
  requireString(row, "sourceObject");
  requireString(row, "sourcePath");
  requireNumber(row, "line");
  requireNumber(row, "column");
}

function requireString(row: Record<string, unknown>, key: string): void {
  if (typeof row[key] !== "string" || row[key] === "") {
    issues.push({ file: currentFile, line: currentLine, message: `Missing nonempty string field ${key}` });
  }
}

function requireOptionalString(row: Record<string, unknown>, key: string): void {
  if (row[key] !== undefined && typeof row[key] !== "string") {
    issues.push({ file: currentFile, line: currentLine, message: `Expected optional string field ${key}` });
  }
}

function requireNumber(row: Record<string, unknown>, key: string): void {
  if (typeof row[key] !== "number" || !Number.isInteger(row[key]) || row[key] < 0) {
    issues.push({ file: currentFile, line: currentLine, message: `Missing nonnegative integer field ${key}` });
  }
}

function requireOptionalNumber(row: Record<string, unknown>, key: string): void {
  if (row[key] !== undefined && (typeof row[key] !== "number" || !Number.isInteger(row[key]) || row[key] < 0)) {
    issues.push({ file: currentFile, line: currentLine, message: `Expected optional nonnegative integer field ${key}` });
  }
}

function requireStringArray(row: Record<string, unknown>, key: string): void {
  const value = row[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    issues.push({ file: currentFile, line: currentLine, message: `Missing string array field ${key}` });
  }
}

function requireOptionalStringArray(row: Record<string, unknown>, key: string): void {
  const value = row[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    issues.push({ file: currentFile, line: currentLine, message: `Expected optional string array field ${key}` });
  }
}

function validateInheritancePath(row: Record<string, unknown>): void {
  const path = row.inheritancePath;
  const depth = row.inheritanceDepth;
  const receiverObject = row.receiverObject;
  const definedOn = row.definedOn;
  if (!Array.isArray(path) || typeof depth !== "number" || typeof receiverObject !== "string" || typeof definedOn !== "string") return;
  if (path.length !== depth + 1) {
    issues.push({ file: currentFile, line: currentLine, message: `inheritancePath length ${path.length} does not match depth ${depth}` });
  }
  if (path[0] !== receiverObject) {
    issues.push({ file: currentFile, line: currentLine, message: `inheritancePath starts at ${String(path[0])}, expected receiverObject ${receiverObject}` });
  }
  if (definedOn !== "builtin" && path[path.length - 1] !== definedOn) {
    issues.push({ file: currentFile, line: currentLine, message: `inheritancePath ends at ${String(path[path.length - 1])}, expected definedOn ${definedOn}` });
  }
}

function validateSourceReference(
  row: Record<string, unknown>,
  source: { objectIds: Set<string>; verbIds: Set<string>; propertyIds: Set<string> }
): void {
  validateVerbField(row, "sourceVerbId", source);
  validateObjectField(row, "sourceObject", source);
}

function validateObjectField(
  row: Record<string, unknown>,
  key: string,
  source: { objectIds: Set<string> },
  options: { optional?: boolean; allowBuiltin?: boolean } = {}
): void {
  const value = row[key];
  if (value === undefined && options.optional) return;
  if (value === "builtin" && options.allowBuiltin) return;
  if (typeof value !== "string") return;
  if (source.objectIds.size === 0) return;
  if (!source.objectIds.has(value)) {
    issues.push({ file: currentFile, line: currentLine, message: `${key} points at missing object ${value}` });
  }
}

function validateObjectArrayField(row: Record<string, unknown>, key: string, source: { objectIds: Set<string> }): void {
  const value = row[key];
  if (!Array.isArray(value) || source.objectIds.size === 0) return;
  for (const item of value) {
    if (typeof item === "string" && !source.objectIds.has(item)) {
      issues.push({ file: currentFile, line: currentLine, message: `${key} contains missing object ${item}` });
    }
  }
}

function validateSpecialLiteralObject(row: Record<string, unknown>): void {
  const expected = new Map([
    ["#-1", "$nothing"],
    ["#-2", "$ambiguous_match"],
    ["#-3", "$failed_match"]
  ]);
  if (row.object !== row.targetObject) {
    issues.push({ file: currentFile, line: currentLine, message: "special literal object edge must target the referenced object" });
  }
  const specialName = typeof row.object === "string" ? expected.get(row.object) : undefined;
  if (!specialName || row.specialName !== specialName) {
    issues.push({ file: currentFile, line: currentLine, message: `invalid special literal object ${String(row.object)}` });
  }
}

function validateVerbField(row: Record<string, unknown>, key: string, source: { verbIds: Set<string> }): void {
  const value = row[key];
  if (typeof value !== "string") return;
  if (source.verbIds.size === 0) return;
  if (!source.verbIds.has(value)) {
    issues.push({ file: currentFile, line: currentLine, message: `${key} points at missing verb ${value}` });
  }
}

function validatePropertyField(row: Record<string, unknown>, key: string, source: { propertyIds: Set<string> }): void {
  const value = row[key];
  if (typeof value !== "string" || value.startsWith("builtin:")) return;
  if (source.propertyIds.size === 0) return;
  if (!source.propertyIds.has(value)) {
    issues.push({ file: currentFile, line: currentLine, message: `${key} points at missing property ${value}` });
  }
}

function validateDuplicateCandidate(row: Record<string, unknown>): void {
  const key = JSON.stringify({
    kind: row.kind,
    sourceVerbId: row.sourceVerbId,
    line: row.line,
    column: row.column,
    receiverObject: row.receiverObject,
    selector: row.selector,
    property: row.property,
    targetObject: row.targetObject,
    targetVerbId: row.targetVerbId,
    propertyId: row.propertyId
  });
  if (seenCandidateEdges.has(key)) {
    issues.push({ file: currentFile, line: currentLine, message: `Duplicate candidate edge ${key}` });
  }
  seenCandidateEdges.add(key);
}

function compareCount(stats: Record<string, unknown>, statsKey: string, file: string): void {
  const expected = stats[statsKey];
  const actual = counts[file];
  if (expected !== actual) {
    issues.push({ file: "edges/stats.json", message: `${statsKey} is ${String(expected)}, but ${file} has ${String(actual)} rows` });
  }
}

function compareCountValue(expected: number, file: string, label: string): void {
  const actual = counts[file];
  if (expected !== actual) {
    issues.push({ file: "edges/stats.json", message: `${label} count is ${String(expected)}, but ${file} has ${String(actual)} rows` });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
