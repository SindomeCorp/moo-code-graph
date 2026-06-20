import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CoreCandidateRecord, ExtractedObjectRecord, ExtractedPropertyDefinitionRecord, ExtractedVerbRecord } from "@sindomecorp/toaststunt-db-extractor";
import { loadCoreCandidates } from "../load/loadCoreCandidates.js";
import { loadObjects } from "../load/loadObjects.js";
import { loadProperties } from "../load/loadProperties.js";
import { loadVerbs } from "../load/loadVerbs.js";
import { readJsonl } from "../load/JsonlReader.js";
import { loadResolvedGraph, type ResolvedGraphRows } from "../query/queryResolvedGraph.js";
import type { GuardedVerbCallEdge, PropertyCandidateEdge, RootVerbCallEdge, UnresolvedRef, VerbCallCandidateEdge } from "../resolve/types.js";
import type { StoredReportItem, StoredReportManifest } from "./reportStore.js";

export type GraphNodeKind = "verb" | "object" | "property" | "core" | "runtime" | "unresolved" | "summary";
export type GraphEdgeKind = "call" | "property" | "guarded" | "unresolved" | "inheritance" | "core" | "contains" | "summary";
export type GraphSearchResultKind = "verb" | "object" | "core" | "issue";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  object?: string;
  verbId?: string;
  counts?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  label?: string;
  confidence?: string;
  count?: number;
  sourceLocation?: GraphSourceLocation;
  metadata?: Record<string, unknown>;
}

export interface GraphPayload {
  mode: "source_verb" | "neighborhood" | "overview";
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  limit: number;
  total: { nodes: number; edges: number };
  seed?: string;
}

export interface GraphSearchResult {
  id: string;
  kind: GraphSearchResultKind;
  label: string;
  detail?: string;
}

interface GraphSourceLocation {
  sourceVerbId: string;
  sourceVerbName?: string;
  sourceObject: string;
  sourcePath: string;
  line: number;
  column: number;
}

interface GraphContext {
  reportsDir: string;
  dbName: string;
  runId: string;
  runDir: string;
  extractDir: string;
  resolvedDir: string;
  reportDir: string;
  graph: ResolvedGraphRows;
  objects: ExtractedObjectRecord[];
  verbs: ExtractedVerbRecord[];
  properties: ExtractedPropertyDefinitionRecord[];
  coreCandidates: CoreCandidateRecord[];
}

interface MutableGraph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
}

const DEFAULT_LIMIT = 500;
const MAX_SEARCH_RESULTS = 50;
const REPORT_WORKSPACE_FILES = ["code_bugs.jsonl", "handled_expected.jsonl", "dead_code.jsonl", "graph_refinement.jsonl", "code_insights.jsonl"];

export async function searchReportGraph(reportsDir: string, dbName: string, runId: string, query: string): Promise<{ results: GraphSearchResult[] }> {
  const context = await loadGraphContext(reportsDir, dbName, runId);
  const needle = query.trim().toLowerCase();
  if (!needle) return { results: [] };

  const results: GraphSearchResult[] = [];
  for (const verb of context.verbs) {
    const haystack = [verb.id, verb.object, verb.primaryName, ...(verb.names ?? [])].join(" ").toLowerCase();
    if (haystack.includes(needle)) {
      results.push({ id: verbNodeId(verb.id), kind: "verb", label: formatVerbLabel(verb), detail: verb.id });
    }
  }
  for (const object of context.objects) {
    const haystack = [object.id, String(object.objectId), object.name ?? ""].join(" ").toLowerCase();
    if (haystack.includes(needle)) {
      results.push({
        id: objectNodeId(object.id),
        kind: "object",
        label: formatObjectLabel(object.id, object),
        detail: `${object.parents?.length ?? 0} parents`
      });
    }
  }
  for (const candidate of context.coreCandidates) {
    const target = coreCandidateTarget(candidate);
    if (!target) continue;
    const haystack = [candidate.symbol, candidate.property, target].join(" ").toLowerCase();
    if (haystack.includes(needle)) {
      results.push({ id: objectNodeId(target), kind: "core", label: candidate.symbol, detail: target });
    }
  }
  for (const item of await readReportItemsForGraph(context.reportDir)) {
    const haystack = [item.ref, item.sourceVerbId, item.sourceVerbName ?? "", item.sourceObject, item.reason, item.description].join(" ").toLowerCase();
    if (haystack.includes(needle)) {
      results.push({
        id: verbNodeId(item.sourceVerbId),
        kind: "issue",
        label: `${item.sourceObject}:${item.sourceVerbName ?? item.sourceVerbId}`,
        detail: `${item.bucket} / ${item.reason}`
      });
    }
  }

  const seen = new Set<string>();
  return {
    results: results
      .filter((result) => {
        const key = `${result.kind}:${result.id}:${result.detail ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_SEARCH_RESULTS)
  };
}

export async function buildSourceVerbGraph(reportsDir: string, dbName: string, runId: string, sourceVerbId: string, limit = DEFAULT_LIMIT): Promise<GraphPayload> {
  const context = await loadGraphContext(reportsDir, dbName, runId);
  const graph: MutableGraph = { nodes: new Map(), edges: new Map() };
  const sourceVerb = context.verbs.find((verb) => verb.id === sourceVerbId);
  addVerbNode(graph, sourceVerbId, sourceVerb);

  for (const edge of context.graph.verbCallCandidateEdges) {
    if (edge.sourceVerbId === sourceVerbId || edge.targetVerbId === sourceVerbId) addVerbCallEdge(graph, context, edge);
  }
  for (const edge of context.graph.rootVerbCallEdges) {
    if (edge.sourceVerbId === sourceVerbId || edge.targetVerbId === sourceVerbId) addRootVerbCallEdge(graph, context, edge);
  }
  for (const edge of context.graph.guardedVerbCallEdges.filter((edge) => edge.sourceVerbId === sourceVerbId)) addGuardedVerbEdge(graph, edge);
  for (const edge of context.graph.propertyCandidateEdges.filter((edge) => edge.sourceVerbId === sourceVerbId)) addPropertyEdge(graph, context, edge);
  for (const ref of context.graph.unresolvedRefs.filter((ref) => ref.sourceVerbId === sourceVerbId)) addUnresolvedEdge(graph, ref);

  return finalizePayload("source_verb", graph, limit, sourceVerbId);
}

export async function buildNeighborhoodGraph(
  reportsDir: string,
  dbName: string,
  runId: string,
  seed: string,
  depth = 1,
  limit = DEFAULT_LIMIT
): Promise<GraphPayload> {
  const context = await loadGraphContext(reportsDir, dbName, runId);
  const normalizedSeed = normalizeSeed(seed);
  const graph: MutableGraph = { nodes: new Map(), edges: new Map() };
  const visited = new Set<string>();
  let frontier = new Set([normalizedSeed]);
  const maxDepth = Math.max(1, Math.min(depth, 3));

  for (let currentDepth = 0; currentDepth < maxDepth && frontier.size > 0; currentDepth += 1) {
    const next = new Set<string>();
    for (const nodeId of frontier) {
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      if (nodeId.startsWith("verb:")) {
        const verbId = nodeId.slice("verb:".length);
        addVerbNode(graph, verbId, context.verbs.find((verb) => verb.id === verbId));
        for (const edge of context.graph.verbCallCandidateEdges) {
          if (edge.sourceVerbId === verbId || edge.targetVerbId === verbId) {
            addVerbCallEdge(graph, context, edge);
            next.add(verbNodeId(edge.sourceVerbId));
            next.add(verbNodeId(edge.targetVerbId));
          }
        }
        for (const edge of context.graph.rootVerbCallEdges) {
          if (edge.sourceVerbId === verbId || edge.targetVerbId === verbId) {
            addRootVerbCallEdge(graph, context, edge);
            next.add(verbNodeId(edge.sourceVerbId));
            next.add(verbNodeId(edge.targetVerbId));
          }
        }
      } else if (nodeId.startsWith("object:")) {
        const objectId = nodeId.slice("object:".length);
        addObjectNeighborhood(graph, context, objectId);
        for (const verb of context.verbs.filter((verb) => verb.object === objectId)) next.add(verbNodeId(verb.id));
      }
    }
  }

  return finalizePayload("neighborhood", graph, limit, normalizedSeed);
}

export async function buildOverviewGraph(
  reportsDir: string,
  dbName: string,
  runId: string,
  mode: "call" | "object" = "call",
  limit = DEFAULT_LIMIT
): Promise<GraphPayload> {
  const context = await loadGraphContext(reportsDir, dbName, runId);
  const graph: MutableGraph = { nodes: new Map(), edges: new Map() };
  if (mode === "object") {
    for (const object of context.objects) addObjectNode(graph, object.id, object);
    for (const object of context.objects) addObjectNeighborhood(graph, context, object.id, false);
    for (const candidate of context.coreCandidates) {
      const target = coreCandidateTarget(candidate);
      if (!target) continue;
      const coreId = coreNodeId(candidate.symbol);
      addNode(graph, { id: coreId, kind: "core", label: candidate.symbol, object: target, metadata: { property: candidate.property } });
      addObjectNode(graph, target, context.objects.find((object) => object.id === target));
      addEdge(graph, { id: `core:${candidate.symbol}->${target}`, source: coreId, target: objectNodeId(target), kind: "core", label: "core" });
    }
  } else {
    for (const edge of context.graph.verbCallCandidateEdges.slice(0, limit)) addVerbCallEdge(graph, context, edge);
    for (const edge of context.graph.rootVerbCallEdges.slice(0, limit)) addRootVerbCallEdge(graph, context, edge);
    addSummaryNode(graph, "summary:guarded", "Guarded calls", context.graph.guardedVerbCallEdges.length);
    addSummaryNode(graph, "summary:unresolved", "Unresolved calls", context.graph.unresolvedRefs.filter((ref) => ref.refKind === "verb_call").length);
  }
  return finalizePayload("overview", graph, limit, mode);
}

async function loadGraphContext(reportsDir: string, dbName: string, runId: string): Promise<GraphContext> {
  const runDir = join(resolve(reportsDir), dbName, runId);
  const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as StoredReportManifest;
  const extractDir = resolve(manifest.extractDir ?? join(runDir, "extract"));
  const resolvedDir = resolve(manifest.resolvedDir ?? join(runDir, "resolved"));
  const reportDir = resolve(manifest.reportDir ?? join(runDir, "report"));
  const [graph, objects, verbs, properties, coreCandidates] = await Promise.all([
    loadResolvedGraph(resolvedDir),
    loadObjects(extractDir),
    loadVerbs(extractDir),
    loadProperties(extractDir),
    loadCoreCandidates(extractDir)
  ]);
  return { reportsDir: resolve(reportsDir), dbName, runId, runDir, extractDir, resolvedDir, reportDir, graph, objects, verbs, properties, coreCandidates };
}

async function readReportItemsForGraph(reportDir: string): Promise<StoredReportItem[]> {
  const rows: StoredReportItem[] = [];
  for (const fileName of REPORT_WORKSPACE_FILES) {
    try {
      rows.push(...(await readJsonl<StoredReportItem>(join(reportDir, fileName))));
    } catch {
      // Older or partial reports may not have every workspace file.
    }
  }
  return rows;
}

function addVerbCallEdge(graph: MutableGraph, context: GraphContext, edge: VerbCallCandidateEdge): void {
  addVerbNode(graph, edge.sourceVerbId, context.verbs.find((verb) => verb.id === edge.sourceVerbId), edge.sourceVerbName, edge.sourceObject);
  addVerbNode(graph, edge.targetVerbId, context.verbs.find((verb) => verb.id === edge.targetVerbId));
  addEdge(graph, {
    id: `call:${edge.sourceVerbId}:${edge.line}:${edge.column}->${edge.targetVerbId}`,
    source: verbNodeId(edge.sourceVerbId),
    target: verbNodeId(edge.targetVerbId),
    kind: "call",
    label: edge.selector,
    confidence: edge.confidence,
    sourceLocation: sourceLocation(edge),
    metadata: { receiverRaw: edge.receiverRaw, receiverObject: edge.receiverObject, definedOn: edge.definedOn, resolutionKind: edge.resolutionKind }
  });
}

function addRootVerbCallEdge(graph: MutableGraph, context: GraphContext, edge: RootVerbCallEdge): void {
  addVerbNode(graph, edge.sourceVerbId, context.verbs.find((verb) => verb.id === edge.sourceVerbId), edge.sourceVerbName, edge.sourceObject);
  addVerbNode(graph, edge.targetVerbId, context.verbs.find((verb) => verb.id === edge.targetVerbId));
  addEdge(graph, {
    id: `root-call:${edge.sourceVerbId}:${edge.line}:${edge.column}->${edge.targetVerbId}`,
    source: verbNodeId(edge.sourceVerbId),
    target: verbNodeId(edge.targetVerbId),
    kind: "call",
    label: edge.function,
    confidence: edge.confidence,
    sourceLocation: sourceLocation(edge),
    metadata: { definedOn: edge.definedOn, resolutionKind: edge.resolutionKind }
  });
}

function addGuardedVerbEdge(graph: MutableGraph, edge: GuardedVerbCallEdge): void {
  addVerbNode(graph, edge.sourceVerbId, undefined, edge.sourceVerbName, edge.sourceObject);
  const target = runtimeNodeId(edge);
  addNode(graph, {
    id: target,
    kind: "runtime",
    label: `${edge.receiverRaw}:${edge.selector}`,
    object: edge.receiverObject,
    metadata: { guardText: edge.guardText, guardScope: edge.guardScope, resolutionKind: edge.resolutionKind }
  });
  addEdge(graph, {
    id: `guarded:${edge.sourceVerbId}:${edge.line}:${edge.column}`,
    source: verbNodeId(edge.sourceVerbId),
    target,
    kind: "guarded",
    label: edge.selector,
    confidence: edge.confidence,
    sourceLocation: sourceLocation(edge),
    metadata: { guardText: edge.guardText, guardScope: edge.guardScope }
  });
}

function addPropertyEdge(graph: MutableGraph, context: GraphContext, edge: PropertyCandidateEdge): void {
  addVerbNode(graph, edge.sourceVerbId, context.verbs.find((verb) => verb.id === edge.sourceVerbId), edge.sourceVerbName, edge.sourceObject);
  const propertyId = propertyNodeId(edge.propertyId);
  addNode(graph, { id: propertyId, kind: "property", label: edge.property, object: edge.definedOn === "builtin" ? edge.targetObject : edge.definedOn, metadata: { propertyId: edge.propertyId, accessKind: edge.accessKind } });
  addEdge(graph, {
    id: `property:${edge.sourceVerbId}:${edge.line}:${edge.column}->${edge.propertyId}`,
    source: verbNodeId(edge.sourceVerbId),
    target: propertyId,
    kind: "property",
    label: edge.accessKind === "write" ? `write ${edge.property}` : edge.property,
    confidence: edge.confidence,
    sourceLocation: sourceLocation(edge),
    metadata: { receiverRaw: edge.receiverRaw, receiverObject: edge.receiverObject, definedOn: edge.definedOn, resolutionKind: edge.resolutionKind }
  });
}

function addUnresolvedEdge(graph: MutableGraph, ref: UnresolvedRef): void {
  addVerbNode(graph, ref.sourceVerbId, undefined, ref.sourceVerbName, ref.sourceObject);
  const target = unresolvedNodeId(ref);
  addNode(graph, { id: target, kind: "unresolved", label: ref.ref, metadata: { reason: ref.reason, refKind: ref.refKind } });
  addEdge(graph, {
    id: `unresolved:${ref.sourceVerbId}:${ref.line}:${ref.column}`,
    source: verbNodeId(ref.sourceVerbId),
    target,
    kind: "unresolved",
    label: ref.reason,
    sourceLocation: sourceLocation(ref),
    metadata: { refKind: ref.refKind, receiverRaw: ref.receiverRaw, selector: ref.selector }
  });
}

function addObjectNeighborhood(graph: MutableGraph, context: GraphContext, objectId: string, includeMembers = true): void {
  const object = context.objects.find((candidate) => candidate.id === objectId);
  addObjectNode(graph, objectId, object);
  for (const parent of object?.parents ?? []) {
    addObjectNode(graph, parent, context.objects.find((candidate) => candidate.id === parent));
    addEdge(graph, { id: `inherits:${objectId}->${parent}`, source: objectNodeId(objectId), target: objectNodeId(parent), kind: "inheritance", label: "parent" });
  }
  for (const child of object?.children ?? []) {
    addObjectNode(graph, child, context.objects.find((candidate) => candidate.id === child));
    addEdge(graph, { id: `inherits:${child}->${objectId}`, source: objectNodeId(child), target: objectNodeId(objectId), kind: "inheritance", label: "parent" });
  }
  if (!includeMembers) return;
  for (const verb of context.verbs.filter((verb) => verb.object === objectId)) {
    addVerbNode(graph, verb.id, verb);
    addEdge(graph, { id: `contains:${objectId}->${verb.id}`, source: objectNodeId(objectId), target: verbNodeId(verb.id), kind: "contains", label: "verb" });
  }
  for (const property of context.properties.filter((property) => property.object === objectId)) {
    addNode(graph, { id: propertyNodeId(property.id), kind: "property", label: property.name, object: objectId, metadata: { propertyId: property.id } });
    addEdge(graph, { id: `contains:${objectId}->${property.id}`, source: objectNodeId(objectId), target: propertyNodeId(property.id), kind: "contains", label: "property" });
  }
}

function addVerbNode(graph: MutableGraph, verbId: string, verb?: ExtractedVerbRecord, fallbackName?: string, fallbackObject?: string): void {
  addNode(graph, {
    id: verbNodeId(verbId),
    kind: "verb",
    label: verb ? formatVerbLabel(verb) : `${fallbackObject ?? objectFromVerbId(verbId)}:${fallbackName ?? verbId}`,
    object: verb?.object ?? fallbackObject ?? objectFromVerbId(verbId),
    verbId,
    metadata: verb ? { names: verb.names, hasProgram: verb.hasProgram, permissions: verb.permissions, prepositions: verb.prepositions } : undefined
  });
}

function addObjectNode(graph: MutableGraph, objectId: string, object?: ExtractedObjectRecord): void {
  addNode(graph, {
    id: objectNodeId(objectId),
    kind: "object",
    label: formatObjectLabel(objectId, object),
    object: objectId,
    counts: { parents: object?.parents?.length ?? 0, children: object?.children?.length ?? 0 },
    metadata: object ? { name: object.name, recycled: object.recycled, owner: object.owner, location: object.location } : undefined
  });
}

function addSummaryNode(graph: MutableGraph, id: string, label: string, count: number): void {
  addNode(graph, { id, kind: "summary", label, counts: { count } });
}

function addNode(graph: MutableGraph, node: GraphNode): void {
  if (!graph.nodes.has(node.id)) graph.nodes.set(node.id, node);
}

function addEdge(graph: MutableGraph, edge: GraphEdge): void {
  if (!graph.edges.has(edge.id)) graph.edges.set(edge.id, edge);
}

function finalizePayload(mode: GraphPayload["mode"], graph: MutableGraph, limit: number, seed?: string): GraphPayload {
  const nodes = [...graph.nodes.values()];
  const edges = [...graph.edges.values()];
  const cappedNodes = nodes.slice(0, limit);
  const cappedNodeIds = new Set(cappedNodes.map((node) => node.id));
  const cappedEdges = edges.filter((edge) => cappedNodeIds.has(edge.source) && cappedNodeIds.has(edge.target)).slice(0, limit);
  return {
    mode,
    nodes: cappedNodes,
    edges: cappedEdges,
    truncated: nodes.length > cappedNodes.length || edges.length > cappedEdges.length,
    limit,
    total: { nodes: nodes.length, edges: edges.length },
    ...(seed ? { seed } : {})
  };
}

function normalizeSeed(seed: string): string {
  if (seed.startsWith("verb:") || seed.startsWith("object:")) return seed;
  if (/^#[0-9]+:[0-9]+$/.test(seed)) return verbNodeId(seed);
  if (/^#[0-9]+$/.test(seed)) return objectNodeId(seed);
  return seed;
}

function sourceLocation(edge: { sourceVerbId: string; sourceVerbName?: string; sourceObject: string; sourcePath: string; line: number; column: number }): GraphSourceLocation {
  return {
    sourceVerbId: edge.sourceVerbId,
    ...(edge.sourceVerbName ? { sourceVerbName: edge.sourceVerbName } : {}),
    sourceObject: edge.sourceObject,
    sourcePath: edge.sourcePath,
    line: edge.line,
    column: edge.column
  };
}

function coreCandidateTarget(candidate: CoreCandidateRecord): string | undefined {
  return "target" in candidate && typeof candidate.target === "string" ? candidate.target : undefined;
}

function formatVerbLabel(verb: ExtractedVerbRecord): string {
  return `${verb.object}:${verb.primaryName} (${verb.verbIndex})`;
}

function formatObjectLabel(objectId: string, object?: ExtractedObjectRecord): string {
  return object?.name ? `${objectId} ${object.name}` : objectId;
}

function objectFromVerbId(verbId: string): string {
  return verbId.split(":")[0] ?? verbId;
}

function verbNodeId(verbId: string): string {
  return `verb:${verbId}`;
}

function objectNodeId(objectId: string): string {
  return `object:${objectId}`;
}

function propertyNodeId(propertyId: string): string {
  return `property:${propertyId}`;
}

function coreNodeId(symbol: string): string {
  return `core:${symbol}`;
}

function runtimeNodeId(edge: GuardedVerbCallEdge): string {
  return `runtime-call:${edge.sourceVerbId}:${edge.line}:${edge.column}`;
}

function unresolvedNodeId(ref: UnresolvedRef): string {
  return `unresolved:${ref.sourceVerbId}:${ref.line}:${ref.column}`;
}
