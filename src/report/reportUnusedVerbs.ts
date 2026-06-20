import { join } from "node:path";
import type { ExtractedVerbRecord } from "@sindomecorp/toaststunt-db-extractor";
import { loadVerbs } from "../load/loadVerbs.js";
import { loadResolvedGraph } from "../query/queryResolvedGraph.js";
import type { RootVerbCallEdge, VerbCallCandidateEdge } from "../resolve/types.js";

export type UnusedVerbBucket = "no_static_callers" | "non_execute_helper";
export type ExternalEntrypointBucket = "server_or_convention_entrypoint";
export type UnusedVerbEntrypointKind =
  | "toaststunt_listener_hook"
  | "toaststunt_system_hook"
  | "toaststunt_builtin_override"
  | "toaststunt_object_lifecycle_hook"
  | "toastcore_core_extraction_hook";

export interface ReportUnusedVerbsOptions {
  resolvedDir: string;
  extractDir?: string;
  examplesPerBucket?: number;
  programmaticOnly?: boolean;
  requireExecute?: boolean;
}

export interface UnusedVerbFinding {
  bucket: UnusedVerbBucket;
  verbId: string;
  object: string;
  verbIndex: number;
  names: string[];
  primaryName: string;
  sourcePath?: string;
  permissions: string[];
  prepositions: string[];
  argumentSpecs: [string, string, string];
  hasExecute: boolean;
  isProgrammatic: boolean;
  callerCount: number;
  selfCallerCount: number;
}

export interface ExternalEntrypointFinding {
  bucket: ExternalEntrypointBucket;
  verbId: string;
  object: string;
  verbIndex: number;
  names: string[];
  primaryName: string;
  sourcePath?: string;
  permissions: string[];
  prepositions: string[];
  argumentSpecs: [string, string, string];
  hasExecute: boolean;
  isProgrammatic: boolean;
  callerCount: number;
  selfCallerCount: number;
  reachability: Array<"external_entrypoint" | "static_moo_call">;
  entrypointKind?: UnusedVerbEntrypointKind;
  matchedConvention?: string;
  evidence?: string;
}

export interface UnusedVerbBucketSummary {
  bucket: UnusedVerbBucket;
  count: number;
  examples: UnusedVerbFinding[];
}

export interface ExternalEntrypointSummary {
  bucket: ExternalEntrypointBucket;
  count: number;
  examples: ExternalEntrypointFinding[];
}

export interface UnusedVerbsReport {
  resolvedDir: string;
  extractDir: string;
  programmaticOnly: boolean;
  requireExecute: boolean;
  examplesPerBucket: number;
  totalProgrammedVerbCount: number;
  targetVerbCount: number;
  excludedNonProgrammaticCount: number;
  excludedNonExecuteCount: number;
  calledTargetVerbCount: number;
  externallyReachableVerbCount: number;
  unusedTargetVerbCount: number;
  dynamicVerbCallsiteCount: number;
  buckets: UnusedVerbBucketSummary[];
  externalEntrypoints: ExternalEntrypointSummary;
}

export async function reportUnusedVerbs(options: ReportUnusedVerbsOptions): Promise<UnusedVerbsReport> {
  const graph = await loadResolvedGraph(options.resolvedDir);
  const extractDir = options.extractDir ?? sourceExtractDirFromManifest(graph.manifest);
  if (!extractDir) {
    throw new Error("report unused-verbs requires --extract when resolved manifest has no sourceExtractDir");
  }

  const examplesPerBucket = options.examplesPerBucket ?? 25;
  const programmaticOnly = options.programmaticOnly ?? true;
  const requireExecute = options.requireExecute ?? false;
  const verbs = await loadVerbs(extractDir);
  const programmed = verbs.filter((verb) => verb.hasProgram);
  const callerCounts = buildCallerCounts([...graph.verbCallCandidateEdges, ...graph.rootVerbCallEdges]);
  const dynamicVerbCallsiteCount = graph.unresolvedRefs.filter((ref) => ref.refKind === "verb_call" && ref.reason === "dynamic_selector").length;

  const targetVerbs: ExtractedVerbRecord[] = [];
  let excludedNonProgrammaticCount = 0;
  let excludedNonExecuteCount = 0;
  for (const verb of programmed) {
    if (programmaticOnly && !isProgrammaticVerb(verb)) {
      excludedNonProgrammaticCount += 1;
      continue;
    }
    if (requireExecute && !hasExecute(verb)) {
      excludedNonExecuteCount += 1;
      continue;
    }
    targetVerbs.push(verb);
  }

  const classifiedTargetVerbs = targetVerbs.map((verb) => ({
    verb,
    counts: callerCounts.get(verb.id) ?? { total: 0, self: 0 },
    entrypoint: classifyEntrypoint(verb)
  }));

  const externalEntrypoints = classifiedTargetVerbs
    .filter(({ entrypoint }) => Boolean(entrypoint))
    .map(({ verb, counts, entrypoint }): ExternalEntrypointFinding => {
      const callerCount = counts.total;
      return {
        bucket: "server_or_convention_entrypoint",
        ...verbFindingBase(verb, counts),
        reachability: callerCount > 0 ? ["external_entrypoint", "static_moo_call"] : ["external_entrypoint"],
        ...(entrypoint ?? {})
      };
    })
    .sort(compareVerbFindings);

  const findings = classifiedTargetVerbs
    .filter(({ counts, entrypoint }) => counts.total === 0 && !entrypoint)
    .map(({ verb, counts }): UnusedVerbFinding => {
      return {
        bucket: hasExecute(verb) ? "no_static_callers" : "non_execute_helper",
        ...verbFindingBase(verb, counts)
      };
    })
    .sort(compareVerbFindings);

  const buckets = summarizeBuckets(findings, examplesPerBucket);
  return {
    resolvedDir: options.resolvedDir,
    extractDir,
    programmaticOnly,
    requireExecute,
    examplesPerBucket,
    totalProgrammedVerbCount: programmed.length,
    targetVerbCount: targetVerbs.length,
    excludedNonProgrammaticCount,
    excludedNonExecuteCount,
    calledTargetVerbCount: classifiedTargetVerbs.filter(({ counts }) => counts.total > 0).length,
    externallyReachableVerbCount: externalEntrypoints.length,
    unusedTargetVerbCount: findings.length,
    dynamicVerbCallsiteCount,
    buckets,
    externalEntrypoints: {
      bucket: "server_or_convention_entrypoint",
      count: externalEntrypoints.length,
      examples: externalEntrypoints.slice(0, examplesPerBucket)
    }
  };
}

export function formatUnusedVerbsReport(report: UnusedVerbsReport): string {
  const lines = [
    `Unused verb candidates: ${report.unusedTargetVerbCount}`,
    `  target programmed verbs: ${report.targetVerbCount}`,
    `  called target verbs: ${report.calledTargetVerbCount}`,
    `  external entrypoints: ${report.externallyReachableVerbCount}`,
    `  excluded non-programmatic verbs: ${report.excludedNonProgrammaticCount}`,
    `  excluded non-execute verbs: ${report.excludedNonExecuteCount}`,
    `  unresolved dynamic verb callsites: ${report.dynamicVerbCallsiteCount}`,
    `  filters: ${report.programmaticOnly ? "programmatic-only" : "all-programmed"}${report.requireExecute ? ", require +x" : ""}`
  ];
  for (const bucket of report.buckets) {
    if (bucket.count === 0) continue;
    lines.push("");
    lines.push(`${bucket.bucket}: ${bucket.count}`);
    for (const finding of bucket.examples) {
      const names = finding.names.length > 0 ? finding.names.join(" ") : finding.primaryName;
      const source = finding.sourcePath ? ` ${finding.sourcePath}` : "";
      lines.push(`  ${finding.verbId} ${finding.object}:${names} [${finding.permissions.join(",") || "no-perms"}; args=${finding.argumentSpecs.join(" ")}]${source}`);
    }
  }
  if (report.externalEntrypoints.count > 0) {
    lines.push("");
    lines.push(`External entrypoints: ${report.externalEntrypoints.count}`);
    for (const finding of report.externalEntrypoints.examples) {
      const names = finding.names.length > 0 ? finding.names.join(" ") : finding.primaryName;
      const source = finding.sourcePath ? ` ${finding.sourcePath}` : "";
      lines.push(
        `  ${finding.verbId} ${finding.object}:${names} [${finding.reachability.join("+")}; args=${finding.argumentSpecs.join(" ")}; static-callers=${finding.callerCount}; entrypoint=${finding.matchedConvention ?? finding.entrypointKind ?? "unknown"}]${source}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function sourceExtractDirFromManifest(manifest: Record<string, unknown>): string | undefined {
  return typeof manifest.sourceExtractDir === "string" ? manifest.sourceExtractDir : undefined;
}

function buildCallerCounts(edges: Array<VerbCallCandidateEdge | RootVerbCallEdge>): Map<string, { total: number; self: number }> {
  const counts = new Map<string, { total: number; self: number }>();
  for (const edge of edges) {
    const existing = counts.get(edge.targetVerbId) ?? { total: 0, self: 0 };
    existing.total += 1;
    if (edge.sourceVerbId === edge.targetVerbId) existing.self += 1;
    counts.set(edge.targetVerbId, existing);
  }
  return counts;
}

function summarizeBuckets(findings: UnusedVerbFinding[], examplesPerBucket: number): UnusedVerbBucketSummary[] {
  return (["no_static_callers", "non_execute_helper"] as const).map((bucket) => {
    const rows = findings.filter((finding) => finding.bucket === bucket);
    return {
      bucket,
      count: rows.length,
      examples: rows.slice(0, examplesPerBucket)
    };
  });
}

export function verbFindingBase(verb: ExtractedVerbRecord, counts: { total: number; self: number }) {
  return {
    verbId: verb.id,
    object: verb.object,
    verbIndex: verb.verbIndex,
    names: verb.names ?? [],
    primaryName: verb.primaryName ?? verb.names?.[0] ?? verb.id,
    ...(verb.sourcePath ? { sourcePath: verb.sourcePath } : {}),
    permissions: permissionsOf(verb),
    prepositions: prepositionsOf(verb),
    argumentSpecs: argumentSpecsOf(verb),
    hasExecute: hasExecute(verb),
    isProgrammatic: isProgrammaticVerb(verb),
    callerCount: counts.total,
    selfCallerCount: counts.self
  };
}

export function isProgrammaticVerb(verb: ExtractedVerbRecord): boolean {
  const [dobj, prep, iobj] = argumentSpecsOf(verb);
  return dobj === "this" && prep === "none" && iobj === "this";
}

export function hasExecute(verb: ExtractedVerbRecord): boolean {
  return typeof verb.permissionsRaw === "number" ? (verb.permissionsRaw & 4) !== 0 : permissionsOf(verb).includes("execute");
}

export function permissionsOf(verb: ExtractedVerbRecord): string[] {
  if (typeof verb.permissionsRaw === "number") {
    const raw = verb.permissionsRaw;
    const permissions: string[] = [];
    if (raw & 1) permissions.push("read");
    if (raw & 2) permissions.push("write");
    if (raw & 4) permissions.push("execute");
    if (raw & 8) permissions.push("debug");
    return permissions;
  }
  return Array.isArray(verb.permissions) ? verb.permissions.map((permission) => String(permission).toLowerCase()).filter((permission) => permission !== "dobj" && permission !== "iobj") : [];
}

export function prepositionsOf(verb: ExtractedVerbRecord): string[] {
  return Array.isArray(verb.prepositions) ? verb.prepositions.map((preposition) => String(preposition).toLowerCase()) : [];
}

export function argumentSpecsOf(verb: ExtractedVerbRecord): [string, string, string] {
  const dobj = typeof verb.permissionsRaw === "number" ? argSpecName((verb.permissionsRaw >> 4) & 0x3) : "unknown";
  const prep = prepositionsOf(verb).join("/") || "unknown";
  const iobj = typeof verb.permissionsRaw === "number" ? argSpecName((verb.permissionsRaw >> 6) & 0x3) : "unknown";
  return [dobj, prep, iobj];
}

function argSpecName(value: number): string {
  if (value === 0) return "none";
  if (value === 1) return "any";
  if (value === 2) return "this";
  return "unknown";
}

function classifyEntrypoint(verb: ExtractedVerbRecord): Pick<ExternalEntrypointFinding, "entrypointKind" | "matchedConvention" | "evidence"> | undefined {
  const names = (verb.names?.length ? verb.names : [verb.primaryName]).filter(Boolean).map((name) => String(name).toLowerCase());
  const object = verb.object;
  const matchedName = names.find((name) => LISTENER_HOOKS.has(name));
  if (matchedName) {
    return {
      entrypointKind: "toaststunt_listener_hook",
      matchedConvention: matchedName,
      evidence: "ToastStunt listener objects receive connection hooks via src/tasks.cc and src/server.cc."
    };
  }

  const systemHook = object === "#0" ? names.find((name) => SYSTEM_OBJECT_HOOKS.has(name)) : undefined;
  if (systemHook) {
    return {
      entrypointKind: "toaststunt_system_hook",
      matchedConvention: `#0:${systemHook}`,
      evidence: "ToastStunt runs this hook on #0 from src/server.cc."
    };
  }

  const lifecycleHook = names.find((name) => OBJECT_LIFECYCLE_HOOKS.has(name));
  if (lifecycleHook) {
    return {
      entrypointKind: "toaststunt_object_lifecycle_hook",
      matchedConvention: lifecycleHook,
      evidence: "ToastStunt calls this object lifecycle hook from src/objects.cc."
    };
  }

  const coreHook = names.find((name) => TOASTCORE_CORE_EXTRACTION_HOOKS.has(name));
  if (coreHook) {
    return {
      entrypointKind: "toastcore_core_extraction_hook",
      matchedConvention: coreHook,
      evidence: "ToastCore documents and invokes this core-extraction hook during core traversal/build."
    };
  }

  const builtinOverride = object === "#0" ? names.find((name) => name.startsWith("bf_") && name.length > 3) : undefined;
  if (builtinOverride) {
    return {
      entrypointKind: "toaststunt_builtin_override",
      matchedConvention: `#0:${builtinOverride}`,
      evidence: "ToastStunt redirects protected built-ins to #0:bf_<function> from src/functions.cc."
    };
  }

  return undefined;
}

const LISTENER_HOOKS = new Set([
  "do_blank_command",
  "do_command",
  "do_login_command",
  "do_out_of_band_command",
  "user_created",
  "user_connected",
  "user_reconnected",
  "user_disconnected",
  "user_client_disconnected"
]);

const SYSTEM_OBJECT_HOOKS = new Set([
  "checkpoint_finished",
  "checkpoint_started",
  "do_start_script",
  "handle_lagging_task",
  "handle_signal",
  "handle_task_timeout",
  "handle_uncaught_error",
  "server_started"
]);
const OBJECT_LIFECYCLE_HOOKS = new Set(["accept", "enterfunc", "exitfunc", "initialize", "recycle"]);
const TOASTCORE_CORE_EXTRACTION_HOOKS = new Set(["include_for_core", "init_for_core", "proxy_for_core"]);

function compareVerbFindings(left: UnusedVerbFinding | ExternalEntrypointFinding, right: UnusedVerbFinding | ExternalEntrypointFinding): number {
  return left.object.localeCompare(right.object) || left.verbIndex - right.verbIndex || left.verbId.localeCompare(right.verbId);
}
