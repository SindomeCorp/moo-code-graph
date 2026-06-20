import type {
  GuardedPropertyAccessEdge,
  GuardedVerbCallEdge,
  UnresolvedPropertyAccessFinding,
  UnresolvedRef,
  UnresolvedVerbCallFinding
} from "../resolve/types.js";
import { loadResolvedGraph } from "../query/queryResolvedGraph.js";

export interface ReportIssuesOptions {
  resolvedDir: string;
  examplesPerBucket?: number;
  domain?: IssueDomain;
  bucket?: IssueBucket;
  reason?: string;
}

export type IssueDomain = "moo_bug" | "handled_inline" | "graph_refinement";
export type IssueBucket =
  | "missing_core_reference"
  | "missing_core_target_object"
  | "missing_object"
  | "missing_verb"
  | "invalid_property_reference"
  | "definite_issue"
  | "handled_inline_issue"
  | "optional_composition_hook"
  | "guarded_runtime_property"
  | "guarded_runtime_verb"
  | "runtime_universal_property"
  | "runtime_dependent"
  | "model_gap"
  | "candidate_miss";

export interface IssueFinding {
  domain: IssueDomain;
  bucket: IssueBucket;
  refKind: "system_object" | "literal_object" | "verb_call" | "property_access";
  ref: string;
  reason: string;
  sourceVerbId: string;
  sourceVerbName?: string;
  sourceObject: string;
  sourcePath: string;
  sourceLine?: string;
  line: number;
  column: number;
  receiverObject?: string;
  candidateObjects?: string[];
  receiverRaw?: string;
  property?: string;
  propertyExpression?: string;
  compositionKind?: "feature_list_hook";
  optionalHookHandled?: boolean;
  inlineErrorHandled?: boolean;
  inlineErrorCodes?: string[];
  inlineErrorFallbackText?: string;
  inlineErrorExpressionText?: string;
  guardText?: string;
  guardScope?: string;
}

export interface IssueBucketSummary {
  bucket: IssueBucket;
  count: number;
  byReason: Array<{ reason: string; count: number }>;
  examples: IssueFinding[];
}

export interface IssuesReport {
  resolvedDir: string;
  total: number;
  domains: Array<{ domain: IssueDomain; count: number; buckets: IssueBucketSummary[] }>;
  buckets: IssueBucketSummary[];
}

const definiteReasons = new Set([
  "no_core_candidate",
  "core_candidate_missing_target_object",
  "missing_object",
  "no_matching_direct_or_inherited_verb",
  "no_matching_property",
  "ancestor_cycle"
]);

const runtimeReasons = new Set([
  "player_receiver",
  "caller_receiver",
  "runtime_object_receiver",
  "runtime_object_function_receiver",
  "runtime_property_chain_receiver",
  "argument_receiver",
  "function_return_receiver",
  "destructured_variable_receiver"
]);
const handledGuardReasons = new Set(["validated_runtime_object_receiver"]);

const candidateMissReasons = new Set(["no_matching_content_item_candidate"]);
const reportDomains: IssueDomain[] = ["moo_bug", "handled_inline", "graph_refinement"];
const reportBuckets: IssueBucket[] = [
  "missing_core_reference",
  "missing_core_target_object",
  "missing_object",
  "missing_verb",
  "invalid_property_reference",
  "handled_inline_issue",
  "optional_composition_hook",
  "guarded_runtime_property",
  "guarded_runtime_verb",
  "runtime_universal_property",
  "runtime_dependent",
  "model_gap",
  "candidate_miss",
  "definite_issue"
];
const universalObjectProperties = new Set(["name", "owner", "programmer", "wizard", "r", "w", "f", "a", "location", "last_move", "contents"]);
const reportDomainSet = new Set<IssueDomain>(reportDomains);
const reportBucketSet = new Set<IssueBucket>(reportBuckets);

export async function reportIssues(options: ReportIssuesOptions): Promise<IssuesReport> {
  validateReportFilters(options);
  const graph = await loadResolvedGraph(options.resolvedDir);
  const findings = filterIssues([
    ...graph.unresolvedRefs
      .filter((ref) => ref.refKind === "system_object" || ref.refKind === "literal_object")
      .map(issueFromUnresolvedRef),
    ...graph.guardedPropertyAccessEdges.map(issueFromGuardedProperty),
    ...graph.guardedVerbCallEdges.map(issueFromGuardedVerbCall),
    ...graph.unresolvedVerbCallFindings.map(issueFromVerbCall),
    ...graph.unresolvedPropertyAccessFindings.map(issueFromPropertyAccess)
  ].sort(compareIssues), options);

  const examplesPerBucket = options.examplesPerBucket ?? 10;
  const buckets = summarizeBuckets(findings, examplesPerBucket);
  const domainsToReport = options.domain ? [options.domain] : reportDomains;
  const domains = domainsToReport.map((domain) => {
    const rows = findings.filter((finding) => finding.domain === domain);
    return {
      domain,
      count: rows.length,
      buckets: summarizeBuckets(rows, examplesPerBucket).filter((bucket) => bucket.count > 0)
    };
  }).filter((domain) => !hasReportFilters(options) || options.domain || domain.count > 0);

  return { resolvedDir: options.resolvedDir, total: findings.length, domains, buckets };
}

function validateReportFilters(options: ReportIssuesOptions): void {
  if (options.domain && !reportDomainSet.has(options.domain)) {
    throw new Error(`Unknown issue domain ${options.domain}. Expected one of: ${reportDomains.join(", ")}`);
  }
  if (options.bucket && !reportBucketSet.has(options.bucket)) {
    throw new Error(`Unknown issue bucket ${options.bucket}. Expected one of: ${reportBuckets.join(", ")}`);
  }
}

function filterIssues(findings: IssueFinding[], options: ReportIssuesOptions): IssueFinding[] {
  return findings.filter(
    (finding) =>
      (!options.domain || finding.domain === options.domain) &&
      (!options.bucket || finding.bucket === options.bucket) &&
      (!options.reason || finding.reason === options.reason)
  );
}

function hasReportFilters(options: ReportIssuesOptions): boolean {
  return !!options.domain || !!options.bucket || !!options.reason;
}

function summarizeBuckets(findings: IssueFinding[], examplesPerBucket: number): IssueBucketSummary[] {
  return reportBuckets.map((bucket) => {
    const rows = findings.filter((finding) => finding.bucket === bucket);
    return {
      bucket,
      count: rows.length,
      byReason: groupReasons(rows),
      examples: rows.slice(0, examplesPerBucket)
    };
  });
}

export function formatIssuesReport(report: IssuesReport): string {
  const lines = [`Issues report: ${report.total}`];
  for (const domain of report.domains) {
    lines.push("");
    lines.push(`${domain.domain}: ${domain.count}`);
    for (const bucket of domain.buckets) {
      lines.push(`  ${bucket.bucket}: ${bucket.count}`);
      for (const reason of bucket.byReason) lines.push(`    ${reason.reason}: ${reason.count}`);
      for (const finding of bucket.examples) {
        const verb = finding.sourceVerbName ? `${finding.sourceObject}:${finding.sourceVerbName}` : finding.sourceObject;
        lines.push(`    ${finding.sourcePath}:${finding.line}:${finding.column} ${verb} ${finding.ref} [${finding.reason}]`);
        if (finding.inlineErrorHandled) lines.push(`      handled inline errors: ${(finding.inlineErrorCodes ?? []).join(", ") || "unknown"}`);
        if (finding.sourceLine) lines.push(`      ${finding.sourceLine.trim()}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function issueFromUnresolvedRef(ref: UnresolvedRef): IssueFinding {
  const issue: Omit<IssueFinding, "domain" | "bucket"> = {
    refKind: ref.refKind,
    ref: ref.ref,
    reason: ref.reason,
    sourceVerbId: ref.sourceVerbId,
    sourceVerbName: ref.sourceVerbName,
    sourceObject: ref.sourceObject,
    sourcePath: ref.sourcePath,
    line: ref.line,
    column: ref.column,
    ...(ref.receiverObject ? { receiverObject: ref.receiverObject } : {})
  };
  return { ...issue, ...classifyIssue(ref.reason, issue) };
}

function issueFromVerbCall(finding: UnresolvedVerbCallFinding): IssueFinding {
  const issue: Omit<IssueFinding, "domain" | "bucket"> = {
    refKind: "verb_call",
    ref: finding.ref,
    reason: finding.reason,
    sourceVerbId: finding.sourceVerbId,
    sourceVerbName: finding.sourceVerbName,
    sourceObject: finding.sourceObject,
    sourcePath: finding.sourcePath,
    ...(finding.sourceLine ? { sourceLine: finding.sourceLine } : {}),
    line: finding.line,
    column: finding.column,
    ...(finding.receiverObject ? { receiverObject: finding.receiverObject } : {}),
    ...(finding.candidateObjects ? { candidateObjects: finding.candidateObjects } : {}),
    ...(finding.compositionKind ? { compositionKind: finding.compositionKind } : {}),
    ...(finding.optionalHookHandled !== undefined ? { optionalHookHandled: finding.optionalHookHandled } : {}),
    ...(finding.inlineErrorHandled !== undefined ? { inlineErrorHandled: finding.inlineErrorHandled } : {}),
    ...(finding.inlineErrorCodes ? { inlineErrorCodes: finding.inlineErrorCodes } : {}),
    ...(finding.inlineErrorFallbackText ? { inlineErrorFallbackText: finding.inlineErrorFallbackText } : {}),
    ...(finding.inlineErrorExpressionText ? { inlineErrorExpressionText: finding.inlineErrorExpressionText } : {})
  };
  return { ...issue, ...classifyIssue(finding.reason, issue) };
}

function issueFromPropertyAccess(finding: UnresolvedPropertyAccessFinding): IssueFinding {
  const issue: Omit<IssueFinding, "domain" | "bucket"> = {
    refKind: "property_access",
    ref: finding.ref,
    reason: finding.reason,
    sourceVerbId: finding.sourceVerbId,
    sourceVerbName: finding.sourceVerbName,
    sourceObject: finding.sourceObject,
    sourcePath: finding.sourcePath,
    ...(finding.sourceLine ? { sourceLine: finding.sourceLine } : {}),
    line: finding.line,
    column: finding.column,
    receiverRaw: finding.receiverRaw,
    ...(finding.receiverObject ? { receiverObject: finding.receiverObject } : {}),
    ...(finding.property ? { property: finding.property } : {}),
    ...(finding.propertyExpression ? { propertyExpression: finding.propertyExpression } : {}),
    ...(finding.inlineErrorHandled !== undefined ? { inlineErrorHandled: finding.inlineErrorHandled } : {}),
    ...(finding.inlineErrorCodes ? { inlineErrorCodes: finding.inlineErrorCodes } : {}),
    ...(finding.inlineErrorFallbackText ? { inlineErrorFallbackText: finding.inlineErrorFallbackText } : {}),
    ...(finding.inlineErrorExpressionText ? { inlineErrorExpressionText: finding.inlineErrorExpressionText } : {})
  };
  return { ...issue, ...classifyIssue(finding.reason, issue) };
}

function issueFromGuardedProperty(edge: GuardedPropertyAccessEdge): IssueFinding {
  return {
    domain: "handled_inline",
    bucket: "guarded_runtime_property",
    refKind: "property_access",
    ref: edge.ref,
    reason: edge.resolutionKind,
    sourceVerbId: edge.sourceVerbId,
    sourceVerbName: edge.sourceVerbName,
    sourceObject: edge.sourceObject,
    sourcePath: edge.sourcePath,
    line: edge.line,
    column: edge.column,
    receiverRaw: edge.receiverRaw,
    ...(edge.receiverObject ? { receiverObject: edge.receiverObject } : {}),
    property: edge.property,
    guardText: edge.guardText,
    guardScope: edge.guardScope
  };
}

function issueFromGuardedVerbCall(edge: GuardedVerbCallEdge): IssueFinding {
  return {
    domain: "handled_inline",
    bucket: "guarded_runtime_verb",
    refKind: "verb_call",
    ref: edge.ref,
    reason: edge.resolutionKind,
    sourceVerbId: edge.sourceVerbId,
    sourceVerbName: edge.sourceVerbName,
    sourceObject: edge.sourceObject,
    sourcePath: edge.sourcePath,
    line: edge.line,
    column: edge.column,
    receiverRaw: edge.receiverRaw,
    ...(edge.receiverObject ? { receiverObject: edge.receiverObject } : {}),
    guardText: edge.guardText,
    guardScope: edge.guardScope
  };
}

function classifyIssue(
  reason: string,
  finding: Pick<IssueFinding, "refKind" | "inlineErrorHandled" | "optionalHookHandled" | "property">
): { domain: IssueDomain; bucket: IssueBucket } {
  if (finding.inlineErrorHandled) return { domain: "handled_inline", bucket: "handled_inline_issue" };
  if (finding.optionalHookHandled) return { domain: "handled_inline", bucket: "optional_composition_hook" };
  if (handledGuardReasons.has(reason)) return { domain: "handled_inline", bucket: "guarded_runtime_property" };
  if (isRuntimeUniversalProperty(reason, finding)) return { domain: "graph_refinement", bucket: "runtime_universal_property" };
  if (definiteReasons.has(reason)) return { domain: "moo_bug", bucket: definiteIssueBucket(reason) };
  if (runtimeReasons.has(reason)) return { domain: "graph_refinement", bucket: "runtime_dependent" };
  if (candidateMissReasons.has(reason)) return { domain: "graph_refinement", bucket: "candidate_miss" };
  return { domain: "graph_refinement", bucket: "model_gap" };
}

function definiteIssueBucket(reason: string): IssueBucket {
  switch (reason) {
    case "no_core_candidate":
      return "missing_core_reference";
    case "core_candidate_missing_target_object":
      return "missing_core_target_object";
    case "missing_object":
      return "missing_object";
    case "no_matching_direct_or_inherited_verb":
      return "missing_verb";
    case "no_matching_property":
      return "invalid_property_reference";
    case "ancestor_cycle":
      return "definite_issue";
  }
  return "definite_issue";
}

function isRuntimeUniversalProperty(reason: string, finding: Pick<IssueFinding, "refKind" | "property">): boolean {
  return finding.refKind === "property_access" && !!finding.property && runtimeReasons.has(reason) && universalObjectProperties.has(finding.property.toLowerCase());
}

function groupReasons(findings: IssueFinding[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.reason, (counts.get(finding.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function compareIssues(left: IssueFinding, right: IssueFinding): number {
  return (
    left.sourcePath.localeCompare(right.sourcePath) ||
    left.line - right.line ||
    left.column - right.column ||
    left.ref.localeCompare(right.ref)
  );
}
