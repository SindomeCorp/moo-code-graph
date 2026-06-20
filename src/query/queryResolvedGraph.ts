import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InferredReceiverCandidateFact, LocalVariableStateFact } from "../flow/types.js";
import { readJsonl } from "../load/JsonlReader.js";
import type {
  LiteralObjectEdge,
  GuardedPropertyAccessEdge,
  GuardedVerbCallEdge,
  PropertyCandidateEdge,
  RootPropertyEdge,
  RootVerbCallEdge,
  SystemObjectEdge,
  UnresolvedPropertyAccessFinding,
  UnresolvedRef,
  UnresolvedVerbCallFinding,
  VerbCallCandidateEdge
} from "../resolve/types.js";

export interface QueryResolvedGraphOptions {
  resolvedDir: string;
}

export interface ExplainReceiverOptions extends QueryResolvedGraphOptions {
  sourcePath: string;
  line: number;
  column?: number;
}

export interface QueryCallersOptions extends QueryResolvedGraphOptions {
  targetVerbId: string;
}

export interface QueryRefsOptions extends QueryResolvedGraphOptions {
  object?: string;
  symbol?: string;
}

export interface QuerySourceVerbOptions extends QueryResolvedGraphOptions {
  sourceVerbId: string;
}

export interface ResolvedGraphRows {
  manifest: Record<string, unknown>;
  systemObjectEdges: SystemObjectEdge[];
  rootPropertyEdges: RootPropertyEdge[];
  rootVerbCallEdges: RootVerbCallEdge[];
  literalObjectEdges: LiteralObjectEdge[];
  verbCallCandidateEdges: VerbCallCandidateEdge[];
  propertyCandidateEdges: PropertyCandidateEdge[];
  guardedPropertyAccessEdges: GuardedPropertyAccessEdge[];
  guardedVerbCallEdges: GuardedVerbCallEdge[];
  unresolvedRefs: UnresolvedRef[];
  unresolvedVerbCallFindings: UnresolvedVerbCallFinding[];
  unresolvedPropertyAccessFindings: UnresolvedPropertyAccessFinding[];
  localVariableStates: LocalVariableStateFact[];
  inferredReceiverCandidates: InferredReceiverCandidateFact[];
}

export interface ReceiverExplanation {
  resolvedDir: string;
  sourcePath: string;
  line: number;
  column?: number;
  inferredReceiverCandidates: InferredReceiverCandidateFact[];
  verbCallCandidateEdges: VerbCallCandidateEdge[];
  propertyCandidateEdges: PropertyCandidateEdge[];
  guardedPropertyAccessEdges: GuardedPropertyAccessEdge[];
  guardedVerbCallEdges: GuardedVerbCallEdge[];
  unresolvedVerbCalls: UnresolvedVerbCallFinding[];
  unresolvedPropertyAccesses: UnresolvedPropertyAccessFinding[];
}

export interface CallerQueryResult {
  resolvedDir: string;
  targetVerbId: string;
  count: number;
  callers: Array<VerbCallCandidateEdge | RootVerbCallEdge>;
}

export interface RefQueryResult {
  resolvedDir: string;
  object?: string;
  symbol?: string;
  count: number;
  systemObjectEdges: SystemObjectEdge[];
  rootPropertyEdges: RootPropertyEdge[];
  rootVerbCallEdges: RootVerbCallEdge[];
  literalObjectEdges: LiteralObjectEdge[];
  verbCallCandidateEdges: VerbCallCandidateEdge[];
  propertyCandidateEdges: PropertyCandidateEdge[];
  guardedPropertyAccessEdges: GuardedPropertyAccessEdge[];
  guardedVerbCallEdges: GuardedVerbCallEdge[];
  unresolvedRefs: UnresolvedRef[];
}

export interface SourceVerbQueryResult {
  resolvedDir: string;
  sourceVerbId: string;
  sourceVerbName?: string;
  sourceObject?: string;
  sourcePath?: string;
  systemObjectEdges: SystemObjectEdge[];
  rootPropertyEdges: RootPropertyEdge[];
  rootVerbCallEdges: RootVerbCallEdge[];
  literalObjectEdges: LiteralObjectEdge[];
  verbCallCandidateEdges: VerbCallCandidateEdge[];
  propertyCandidateEdges: PropertyCandidateEdge[];
  guardedPropertyAccessEdges: GuardedPropertyAccessEdge[];
  guardedVerbCallEdges: GuardedVerbCallEdge[];
  unresolvedRefs: UnresolvedRef[];
  unresolvedVerbCalls: UnresolvedVerbCallFinding[];
  unresolvedPropertyAccesses: UnresolvedPropertyAccessFinding[];
  localVariableStates: LocalVariableStateFact[];
  inferredReceiverCandidates: InferredReceiverCandidateFact[];
}

export async function explainReceiver(options: ExplainReceiverOptions): Promise<ReceiverExplanation> {
  const graph = await loadResolvedGraph(options.resolvedDir);
  const matchesLocation = locationMatcher(options.sourcePath, options.line, options.column);
  return {
    resolvedDir: options.resolvedDir,
    sourcePath: options.sourcePath,
    line: options.line,
    ...(options.column !== undefined ? { column: options.column } : {}),
    inferredReceiverCandidates: graph.inferredReceiverCandidates.filter(matchesLocation),
    verbCallCandidateEdges: graph.verbCallCandidateEdges.filter(matchesLocation),
    propertyCandidateEdges: graph.propertyCandidateEdges.filter(matchesLocation),
    guardedPropertyAccessEdges: graph.guardedPropertyAccessEdges.filter(matchesLocation),
    guardedVerbCallEdges: graph.guardedVerbCallEdges.filter(matchesLocation),
    unresolvedVerbCalls: graph.unresolvedVerbCallFindings.filter(matchesLocation),
    unresolvedPropertyAccesses: graph.unresolvedPropertyAccessFindings.filter(matchesLocation)
  };
}

export async function queryCallers(options: QueryCallersOptions): Promise<CallerQueryResult> {
  const graph = await loadResolvedGraph(options.resolvedDir);
  const callers = [...graph.verbCallCandidateEdges, ...graph.rootVerbCallEdges]
    .filter((edge) => edge.targetVerbId === options.targetVerbId)
    .sort(compareLocatedRows);
  return { resolvedDir: options.resolvedDir, targetVerbId: options.targetVerbId, count: callers.length, callers };
}

export async function queryRefs(options: QueryRefsOptions): Promise<RefQueryResult> {
  if (!options.object && !options.symbol) throw new Error("queryRefs requires either object or symbol");
  const graph = await loadResolvedGraph(options.resolvedDir);
  const symbol = options.symbol?.toLowerCase();
  const systemObjectEdges = symbol ? graph.systemObjectEdges.filter((edge) => edge.symbol.toLowerCase() === symbol) : [];
  const rootPropertyEdges = options.symbol
    ? graph.rootPropertyEdges.filter((edge) => edge.symbol.toLowerCase() === symbol)
    : options.object
      ? graph.rootPropertyEdges.filter((edge) => edge.targetObject === options.object || edge.definedOn === options.object)
      : [];
  const rootVerbCallEdges = options.symbol
    ? graph.rootVerbCallEdges.filter((edge) => edge.function.toLowerCase() === symbol)
    : options.object
      ? graph.rootVerbCallEdges.filter((edge) => edge.targetObject === options.object || edge.definedOn === options.object)
      : [];
  const literalObjectEdges = options.object
    ? graph.literalObjectEdges.filter((edge) => edge.object === options.object || edge.targetObject === options.object)
    : [];
  const verbCallCandidateEdges = options.object
    ? graph.verbCallCandidateEdges.filter(
        (edge) => edge.receiverObject === options.object || edge.targetObject === options.object || edge.definedOn === options.object
      )
    : [];
  const propertyCandidateEdges = options.object
    ? graph.propertyCandidateEdges.filter(
        (edge) => edge.receiverObject === options.object || edge.targetObject === options.object || edge.definedOn === options.object
      )
    : [];
  const guardedPropertyAccessEdges = options.object
    ? graph.guardedPropertyAccessEdges.filter((edge) => edge.receiverObject === options.object)
    : [];
  const guardedVerbCallEdges = options.object ? graph.guardedVerbCallEdges.filter((edge) => edge.receiverObject === options.object) : [];
  const unresolvedRefs = graph.unresolvedRefs.filter(
    (ref) =>
      (options.object && (ref.ref === options.object || ref.receiverObject === options.object)) ||
      (symbol && ref.ref.toLowerCase() === symbol)
  );
  return {
    resolvedDir: options.resolvedDir,
    ...(options.object ? { object: options.object } : {}),
    ...(options.symbol ? { symbol: options.symbol } : {}),
    count:
      systemObjectEdges.length +
      rootPropertyEdges.length +
      rootVerbCallEdges.length +
      literalObjectEdges.length +
      verbCallCandidateEdges.length +
      propertyCandidateEdges.length +
      guardedPropertyAccessEdges.length +
      guardedVerbCallEdges.length +
      unresolvedRefs.length,
    systemObjectEdges: systemObjectEdges.sort(compareLocatedRows),
    rootPropertyEdges: rootPropertyEdges.sort(compareLocatedRows),
    rootVerbCallEdges: rootVerbCallEdges.sort(compareLocatedRows),
    literalObjectEdges: literalObjectEdges.sort(compareLocatedRows),
    verbCallCandidateEdges: verbCallCandidateEdges.sort(compareLocatedRows),
    propertyCandidateEdges: propertyCandidateEdges.sort(compareLocatedRows),
    guardedPropertyAccessEdges: guardedPropertyAccessEdges.sort(compareLocatedRows),
    guardedVerbCallEdges: guardedVerbCallEdges.sort(compareLocatedRows),
    unresolvedRefs: unresolvedRefs.sort(compareLocatedRows)
  };
}

export async function querySourceVerb(options: QuerySourceVerbOptions): Promise<SourceVerbQueryResult> {
  const graph = await loadResolvedGraph(options.resolvedDir);
  const sourceRows = [
    ...graph.systemObjectEdges,
    ...graph.rootPropertyEdges,
    ...graph.rootVerbCallEdges,
    ...graph.literalObjectEdges,
    ...graph.verbCallCandidateEdges,
    ...graph.propertyCandidateEdges,
    ...graph.guardedPropertyAccessEdges,
    ...graph.guardedVerbCallEdges,
    ...graph.unresolvedRefs,
    ...graph.unresolvedVerbCallFindings,
    ...graph.unresolvedPropertyAccessFindings,
    ...graph.localVariableStates,
    ...graph.inferredReceiverCandidates
  ].filter((row) => row.sourceVerbId === options.sourceVerbId);
  const named = sourceRows.find((row): row is (typeof row) & { sourceVerbName: string } => "sourceVerbName" in row && typeof row.sourceVerbName === "string");
  const first = sourceRows[0] as Partial<SourceVerbQueryResult> | undefined;
  return {
    resolvedDir: options.resolvedDir,
    sourceVerbId: options.sourceVerbId,
    ...(named ? { sourceVerbName: named.sourceVerbName } : {}),
    ...(typeof first?.sourceObject === "string" ? { sourceObject: first.sourceObject } : {}),
    ...(typeof first?.sourcePath === "string" ? { sourcePath: first.sourcePath } : {}),
    systemObjectEdges: graph.systemObjectEdges.filter((row) => row.sourceVerbId === options.sourceVerbId).sort(compareLocatedRows),
    rootPropertyEdges: graph.rootPropertyEdges.filter((row) => row.sourceVerbId === options.sourceVerbId).sort(compareLocatedRows),
    rootVerbCallEdges: graph.rootVerbCallEdges.filter((row) => row.sourceVerbId === options.sourceVerbId).sort(compareLocatedRows),
    literalObjectEdges: graph.literalObjectEdges.filter((row) => row.sourceVerbId === options.sourceVerbId).sort(compareLocatedRows),
    verbCallCandidateEdges: graph.verbCallCandidateEdges.filter((row) => row.sourceVerbId === options.sourceVerbId).sort(compareLocatedRows),
    propertyCandidateEdges: graph.propertyCandidateEdges.filter((row) => row.sourceVerbId === options.sourceVerbId).sort(compareLocatedRows),
    guardedPropertyAccessEdges: graph.guardedPropertyAccessEdges
      .filter((row) => row.sourceVerbId === options.sourceVerbId)
      .sort(compareLocatedRows),
    guardedVerbCallEdges: graph.guardedVerbCallEdges.filter((row) => row.sourceVerbId === options.sourceVerbId).sort(compareLocatedRows),
    unresolvedRefs: graph.unresolvedRefs.filter((row) => row.sourceVerbId === options.sourceVerbId).sort(compareLocatedRows),
    unresolvedVerbCalls: graph.unresolvedVerbCallFindings.filter((row) => row.sourceVerbId === options.sourceVerbId).sort(compareLocatedRows),
    unresolvedPropertyAccesses: graph.unresolvedPropertyAccessFindings
      .filter((row) => row.sourceVerbId === options.sourceVerbId)
      .sort(compareLocatedRows),
    localVariableStates: graph.localVariableStates.filter((row) => row.sourceVerbId === options.sourceVerbId).sort(compareLocatedRows),
    inferredReceiverCandidates: graph.inferredReceiverCandidates
      .filter((row) => row.sourceVerbId === options.sourceVerbId)
      .sort(compareLocatedRows)
  };
}

export function formatReceiverExplanation(explanation: ReceiverExplanation): string {
  const lines = [`Receiver explanation: ${explanation.sourcePath}:${explanation.line}${explanation.column !== undefined ? `:${explanation.column}` : ""}`];
  appendRows(lines, "Inferred receivers", explanation.inferredReceiverCandidates, formatInferredReceiver);
  appendRows(lines, "Verb candidates", explanation.verbCallCandidateEdges, formatVerbCandidate);
  appendRows(lines, "Property candidates", explanation.propertyCandidateEdges, formatPropertyCandidate);
  appendRows(lines, "Guarded properties", explanation.guardedPropertyAccessEdges, formatGuardedProperty);
  appendRows(lines, "Guarded verb calls", explanation.guardedVerbCallEdges, formatGuardedVerbCall);
  appendRows(lines, "Unresolved verb calls", explanation.unresolvedVerbCalls, formatUnresolvedFinding);
  appendRows(lines, "Unresolved property accesses", explanation.unresolvedPropertyAccesses, formatUnresolvedFinding);
  return `${lines.join("\n")}\n`;
}

export function formatCallerQuery(result: CallerQueryResult): string {
  const lines = [`Callers of ${result.targetVerbId}: ${result.count}`];
  for (const edge of result.callers) {
    lines.push(
      `  ${formatLocation(edge)} ${edge.sourceObject}:${edge.sourceVerbName} ${
        edge.kind === "root_verb_call_edge" ? edge.function : `${edge.receiverRaw}:${edge.selector}`
      }`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatRefQuery(result: RefQueryResult): string {
  const target = result.object ?? result.symbol ?? "";
  const lines = [`Refs to ${target}: ${result.count}`];
  appendRows(lines, "System object refs", result.systemObjectEdges, (edge) => `${formatLocation(edge)} ${edge.symbol} -> ${edge.targetObject}`);
  appendRows(lines, "Root property refs", result.rootPropertyEdges, formatRootProperty);
  appendRows(lines, "Root verb calls", result.rootVerbCallEdges, formatRootVerbCall);
  appendRows(lines, "Literal object refs", result.literalObjectEdges, formatLiteralObjectEdge);
  appendRows(lines, "Verb candidates", result.verbCallCandidateEdges, formatVerbCandidate);
  appendRows(lines, "Property candidates", result.propertyCandidateEdges, formatPropertyCandidate);
  appendRows(lines, "Guarded properties", result.guardedPropertyAccessEdges, formatGuardedProperty);
  appendRows(lines, "Guarded verb calls", result.guardedVerbCallEdges, formatGuardedVerbCall);
  appendRows(lines, "Unresolved refs", result.unresolvedRefs, (ref) => `${formatLocation(ref)} ${ref.ref} [${ref.reason}]`);
  return `${lines.join("\n")}\n`;
}

export function formatSourceVerbQuery(result: SourceVerbQueryResult): string {
  const label = `${result.sourceObject ?? "?"}:${result.sourceVerbName ?? result.sourceVerbId} (${result.sourceVerbId})`;
  const lines = [`Source verb: ${label}`];
  if (result.sourcePath) lines.push(`  ${result.sourcePath}`);
  lines.push(`  system object edges: ${result.systemObjectEdges.length}`);
  lines.push(`  root property edges: ${result.rootPropertyEdges.length}`);
  lines.push(`  root verb calls: ${result.rootVerbCallEdges.length}`);
  lines.push(`  literal object edges: ${result.literalObjectEdges.length}`);
  lines.push(`  verb candidates: ${result.verbCallCandidateEdges.length}`);
  lines.push(`  property candidates: ${result.propertyCandidateEdges.length}`);
  lines.push(`  guarded properties: ${result.guardedPropertyAccessEdges.length}`);
  lines.push(`  guarded verb calls: ${result.guardedVerbCallEdges.length}`);
  lines.push(`  unresolved refs: ${result.unresolvedRefs.length}`);
  lines.push(`  unresolved verb calls: ${result.unresolvedVerbCalls.length}`);
  lines.push(`  unresolved property accesses: ${result.unresolvedPropertyAccesses.length}`);
  lines.push(`  local variable states: ${result.localVariableStates.length}`);
  lines.push(`  inferred receivers: ${result.inferredReceiverCandidates.length}`);
  appendRows(lines, "Verb candidates", result.verbCallCandidateEdges, formatVerbCandidate);
  appendRows(lines, "Root verb calls", result.rootVerbCallEdges, formatRootVerbCall);
  appendRows(lines, "Property candidates", result.propertyCandidateEdges, formatPropertyCandidate);
  appendRows(lines, "Guarded properties", result.guardedPropertyAccessEdges, formatGuardedProperty);
  appendRows(lines, "Guarded verb calls", result.guardedVerbCallEdges, formatGuardedVerbCall);
  appendRows(lines, "Root property refs", result.rootPropertyEdges, formatRootProperty);
  appendRows(lines, "Unresolved verb calls", result.unresolvedVerbCalls, formatUnresolvedFinding);
  appendRows(lines, "Unresolved property accesses", result.unresolvedPropertyAccesses, formatUnresolvedFinding);
  return `${lines.join("\n")}\n`;
}

export async function loadResolvedGraph(resolvedDir: string): Promise<ResolvedGraphRows> {
  return {
    manifest: await readJson<Record<string, unknown>>(join(resolvedDir, "manifest.json")),
    systemObjectEdges: await readJsonl<SystemObjectEdge>(join(resolvedDir, "edges", "system_object_edges.jsonl")),
    rootPropertyEdges: await readJsonlIfExists<RootPropertyEdge>(join(resolvedDir, "edges", "root_property_edges.jsonl")),
    rootVerbCallEdges: await readJsonlIfExists<RootVerbCallEdge>(join(resolvedDir, "edges", "root_verb_call_edges.jsonl")),
    literalObjectEdges: await readJsonl<LiteralObjectEdge>(join(resolvedDir, "edges", "literal_object_edges.jsonl")),
    verbCallCandidateEdges: await readJsonl<VerbCallCandidateEdge>(join(resolvedDir, "edges", "verb_call_candidate_edges.jsonl")),
    propertyCandidateEdges: await readJsonl<PropertyCandidateEdge>(join(resolvedDir, "edges", "property_candidate_edges.jsonl")),
    guardedPropertyAccessEdges: await readJsonlIfExists<GuardedPropertyAccessEdge>(
      join(resolvedDir, "edges", "guarded_property_access_edges.jsonl")
    ),
    guardedVerbCallEdges: await readJsonlIfExists<GuardedVerbCallEdge>(join(resolvedDir, "edges", "guarded_verb_call_edges.jsonl")),
    unresolvedRefs: await readJsonl<UnresolvedRef>(join(resolvedDir, "edges", "unresolved_refs.jsonl")),
    unresolvedVerbCallFindings: await readJsonl<UnresolvedVerbCallFinding>(join(resolvedDir, "findings", "unresolved_verb_calls.jsonl")),
    unresolvedPropertyAccessFindings: await readJsonlIfExists<UnresolvedPropertyAccessFinding>(
      join(resolvedDir, "findings", "unresolved_property_accesses.jsonl")
    ),
    localVariableStates: await readJsonlIfExists<LocalVariableStateFact>(join(resolvedDir, "flow", "local_variable_states.jsonl")),
    inferredReceiverCandidates: await readJsonlIfExists<InferredReceiverCandidateFact>(
      join(resolvedDir, "flow", "inferred_receiver_candidates.jsonl")
    )
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonlIfExists<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  return readJsonl<T>(path);
}

function locationMatcher(sourcePath: string, line: number, column: number | undefined): (row: { sourcePath: string; line: number; column: number }) => boolean {
  return (row) => row.sourcePath === sourcePath && row.line === line && (column === undefined || row.column === column);
}

function appendRows<T>(lines: string[], label: string, rows: T[], format: (row: T) => string): void {
  if (rows.length === 0) return;
  lines.push("");
  lines.push(`${label}: ${rows.length}`);
  for (const row of rows) lines.push(`  ${format(row)}`);
}

function formatLocation(row: { sourcePath: string; line: number; column: number }): string {
  return `${row.sourcePath}:${row.line}:${row.column}`;
}

function formatVerbCandidate(edge: VerbCallCandidateEdge): string {
  return `${formatLocation(edge)} ${edge.sourceObject}:${edge.sourceVerbName} ${edge.receiverRaw}:${edge.selector} -> ${edge.targetVerbId} via ${edge.definedOn}`;
}

function formatRootVerbCall(edge: RootVerbCallEdge): string {
  return `${formatLocation(edge)} ${edge.sourceObject}:${edge.sourceVerbName} ${edge.function} -> ${edge.targetVerbId} via ${edge.definedOn}`;
}

function formatPropertyCandidate(edge: PropertyCandidateEdge): string {
  return `${formatLocation(edge)} ${edge.sourceObject}:${edge.sourceVerbName} ${edge.receiverRaw}.${edge.property} (${edge.receiverObject}) -> ${edge.propertyId} via ${edge.definedOn}`;
}

function formatGuardedProperty(edge: GuardedPropertyAccessEdge): string {
  const receiverObject = edge.receiverObject ? ` (${edge.receiverObject})` : "";
  return `${formatLocation(edge)} ${edge.sourceObject}:${edge.sourceVerbName} ${edge.receiverRaw}.${edge.property}${receiverObject} guarded by ${edge.guardText}`;
}

function formatGuardedVerbCall(edge: GuardedVerbCallEdge): string {
  const receiverObject = edge.receiverObject ? ` (${edge.receiverObject})` : "";
  return `${formatLocation(edge)} ${edge.sourceObject}:${edge.sourceVerbName} ${edge.receiverRaw}:${edge.selector}${receiverObject} guarded by ${edge.guardText}`;
}

function formatRootProperty(edge: RootPropertyEdge): string {
  return `${formatLocation(edge)} ${edge.sourceObject}:${edge.sourceVerbName} ${edge.symbol} -> ${edge.propertyId}`;
}

function formatLiteralObjectEdge(edge: LiteralObjectEdge): string {
  const special = edge.specialName ? ` (${edge.specialName})` : "";
  return `${formatLocation(edge)} ${edge.object}${special}`;
}

function formatInferredReceiver(candidate: InferredReceiverCandidateFact): string {
  const objects = candidate.objects?.length ? ` -> ${candidate.objects.join(",")}` : "";
  const reason = candidate.reason ? ` [${candidate.reason}]` : "";
  return `${formatLocation(candidate)} ${candidate.receiverRaw} ${candidate.valueKind}/${candidate.provenance}${objects}${reason}`;
}

function formatUnresolvedFinding(finding: UnresolvedVerbCallFinding | UnresolvedPropertyAccessFinding): string {
  const target = finding.receiverObject ? ` -> ${finding.receiverObject}` : "";
  const handled = "inlineErrorHandled" in finding && finding.inlineErrorHandled ? ` handled:${(finding.inlineErrorCodes ?? []).join(",") || "unknown"}` : "";
  return `${formatLocation(finding)} ${finding.ref}${target} [${finding.reason}]${handled}`;
}

function compareLocatedRows(left: { sourcePath: string; line: number; column: number }, right: { sourcePath: string; line: number; column: number }): number {
  return left.sourcePath.localeCompare(right.sourcePath) || left.line - right.line || left.column - right.column;
}
