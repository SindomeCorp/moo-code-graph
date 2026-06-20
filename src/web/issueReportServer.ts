import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadResolvedGraph } from "../query/queryResolvedGraph.js";
import { reportIssues, type IssueBucket, type IssueDomain, type IssueFinding } from "../report/reportIssues.js";
import {
  reportUnusedVerbs,
  type ExternalEntrypointBucket,
  type ExternalEntrypointFinding,
  type UnusedVerbBucket,
  type UnusedVerbFinding
} from "../report/reportUnusedVerbs.js";
import { reportUnprogrammedVerbs, type UnprogrammedVerbBucket, type UnprogrammedVerbFinding } from "../report/reportUnprogrammedVerbs.js";
import { reportCodeInsights, type CodeInsightBucket, type CodeInsightFinding } from "../report/reportCodeInsights.js";
import { reportMutationInvariants, type MutationInvariantBucket, type MutationInvariantFinding } from "../report/reportMutationInvariants.js";
import type { ReportConfig } from "../report/reportConfig.js";

export interface BuildIssueWebReportOptions {
  resolvedDir: string;
  contextLines?: number;
  examplesPerReason?: number;
  maxIssues?: number;
  config?: ReportConfig;
}

export interface ServeIssueWebReportOptions extends BuildIssueWebReportOptions {
  host?: string;
  port?: number;
}

export interface ServedIssueWebReport {
  server: Server;
  url: string;
  host: string;
  port: number;
  report: IssueWebReport;
  close: () => Promise<void>;
}

export interface IssueWebReport {
  resolvedDir: string;
  sourceExtractDir?: string;
  generatedAt: string;
  contextLines: number;
  examplesPerReason: number;
  maxIssues: number;
  total: number;
  includedIssueCount: number;
  truncated: boolean;
  domains: IssueWebReportDomain[];
  buckets: IssueWebReportBucket[];
}

export type IssueWebReportDomainKey = IssueDomain | "unused_verbs" | "external_entrypoints" | "unprogrammed_verbs" | "code_insights" | "mutation_invariants";
export type IssueWebReportBucketKey = IssueBucket | UnusedVerbBucket | ExternalEntrypointBucket | UnprogrammedVerbBucket | CodeInsightBucket | MutationInvariantBucket;

export interface IssueWebReportDomain {
  domain: IssueWebReportDomainKey;
  count: number;
  buckets: IssueWebReportBucket[];
}

export interface IssueWebReportBucket {
  bucket: IssueWebReportBucketKey;
  count: number;
  reasons: IssueWebReportReasonGroup[];
}

export interface IssueWebReportReasonGroup {
  reason: string;
  count: number;
  includedCount: number;
  truncated: boolean;
  issues: IssueWebReportIssue[];
}

export type IssueWebReportIssue = (IssueFinding | VerbDefinitionWebFinding | CodeInsightWebFinding | MutationInvariantWebFinding) & {
  description: string;
  sourceSnippet?: IssueWebReportSnippet;
};

export interface VerbDefinitionWebFinding {
  domain: "unused_verbs" | "external_entrypoints" | "unprogrammed_verbs";
  bucket: UnusedVerbBucket | ExternalEntrypointBucket | UnprogrammedVerbBucket;
  refKind: "verb_definition";
  ref: string;
  reason: UnusedVerbBucket | ExternalEntrypointBucket | UnprogrammedVerbBucket;
  sourceVerbId: string;
  sourceVerbName?: string;
  sourceObject: string;
  sourcePath: string;
  sourceLine?: string;
  line: number;
  column: number;
  permissions: string[];
  prepositions: string[];
  argumentSpecs: [string, string, string];
  hasExecute: boolean;
  isProgrammatic: boolean;
  callerCount: number;
  selfCallerCount: number;
  reachability?: Array<"external_entrypoint" | "static_moo_call">;
  entrypointKind?: string;
  matchedConvention?: string;
  evidence?: string;
  receiverObject?: string;
  property?: string;
  guardText?: string;
  guardScope?: string;
  inlineErrorHandled?: boolean;
  inlineErrorCodes?: string[];
  inlineErrorFallbackText?: string;
  inlineErrorExpressionText?: string;
}

export interface CodeInsightWebFinding extends CodeInsightFinding {
  domain: "code_insights";
  sourceLine?: string;
  receiverObject?: string;
  property?: string;
  guardText?: string;
  guardScope?: string;
  inlineErrorHandled?: boolean;
  inlineErrorCodes?: string[];
  inlineErrorFallbackText?: string;
  inlineErrorExpressionText?: string;
}

export interface MutationInvariantWebFinding extends MutationInvariantFinding {
  domain: "mutation_invariants";
  receiverObject?: string;
  guardText?: string;
  guardScope?: string;
  inlineErrorHandled?: boolean;
  inlineErrorCodes?: string[];
  inlineErrorFallbackText?: string;
  inlineErrorExpressionText?: string;
}

export interface IssueWebReportSnippet {
  sourcePath: string;
  startLine: number;
  endLine: number;
  targetLine: number;
  lines: Array<{ line: number; text: string; highlight: boolean }>;
}

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8787;
const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_EXAMPLES_PER_REASON = 25;
const DEFAULT_MAX_ISSUES = 1000;

export async function buildIssueWebReport(options: BuildIssueWebReportOptions): Promise<IssueWebReport> {
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const examplesPerReason = options.examplesPerReason ?? DEFAULT_EXAMPLES_PER_REASON;
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  const graph = await loadResolvedGraph(options.resolvedDir);
  const sourceExtractDir = typeof graph.manifest.sourceExtractDir === "string" ? graph.manifest.sourceExtractDir : undefined;
  const report = await reportIssues({ resolvedDir: options.resolvedDir, examplesPerBucket: Number.MAX_SAFE_INTEGER });
  const sourceCache = new SourceFileCache(sourceExtractDir);
  let remaining = maxIssues;

  const domains: IssueWebReportDomain[] = [];
  for (const domain of report.domains) {
    const buckets: IssueWebReportBucket[] = [];
    for (const bucket of domain.buckets) {
      buckets.push(await buildWebBucket(bucket, sourceCache, contextLines, examplesPerReason, () => remaining, (value) => (remaining = value)));
    }
    domains.push({ domain: domain.domain, count: domain.count, buckets });
  }

  if (sourceExtractDir) {
    const unused = await reportUnusedVerbs({
      resolvedDir: options.resolvedDir,
      extractDir: sourceExtractDir,
      examplesPerBucket: Number.MAX_SAFE_INTEGER,
      programmaticOnly: options.config?.reports.deadCode.unusedVerbs.programmaticOnly ?? true,
      requireExecute: options.config?.reports.deadCode.unusedVerbs.requireExecute ?? false
    });
    domains.push(await buildUnusedVerbDomain(unused.buckets, sourceCache, contextLines, examplesPerReason));
    domains.push(await buildExternalEntrypointDomain(unused.externalEntrypoints, sourceCache, contextLines, examplesPerReason));
    const unprogrammed = await reportUnprogrammedVerbs({
      resolvedDir: options.resolvedDir,
      extractDir: sourceExtractDir,
      examplesPerBucket: Number.MAX_SAFE_INTEGER
    });
    domains.push(await buildUnprogrammedVerbDomain(unprogrammed.buckets, sourceCache, contextLines, examplesPerReason));
  }
  const codeInsights = await reportCodeInsights({
    resolvedDir: options.resolvedDir,
    examplesPerBucket: Number.MAX_SAFE_INTEGER,
    config: options.config?.reports.codeInsights
  });
  domains.push(await buildCodeInsightsDomain(codeInsights.buckets, sourceCache, contextLines, examplesPerReason));
  const mutationInvariants = await reportMutationInvariants({
    resolvedDir: options.resolvedDir,
    examplesPerBucket: Number.MAX_SAFE_INTEGER,
    config: options.config?.reports.mutationInvariants
  });
  domains.push(await buildMutationInvariantsDomain(mutationInvariants.buckets, sourceCache, contextLines, examplesPerReason));

  const buckets = domains.flatMap((domain) => domain.buckets);

  return {
    resolvedDir: options.resolvedDir,
    ...(sourceExtractDir ? { sourceExtractDir } : {}),
    generatedAt: new Date().toISOString(),
    contextLines,
    examplesPerReason,
    maxIssues,
    total: report.total,
    includedIssueCount: maxIssues - remaining,
    truncated: domains.some((domain) => domain.buckets.some((bucket) => bucket.reasons.some((reason) => reason.truncated))),
    domains,
    buckets
  };
}

async function buildWebBucket(
  bucket: { bucket: IssueBucket; count: number; byReason: Array<{ reason: string; count: number }>; examples: IssueFinding[] },
  sourceCache: SourceFileCache,
  contextLines: number,
  examplesPerReason: number,
  getRemaining: () => number,
  setRemaining: (remaining: number) => void
): Promise<IssueWebReportBucket> {
  const bucketRows = bucket.examples;
  const reasons: IssueWebReportReasonGroup[] = [];
  for (const reason of bucket.byReason) {
    const rows = bucketRows.filter((issue) => issue.reason === reason.reason);
    const allowed = Math.max(0, Math.min(rows.length, examplesPerReason, getRemaining()));
    setRemaining(getRemaining() - allowed);
    const issues = await Promise.all(
      rows.slice(0, allowed).map(async (issue): Promise<IssueWebReportIssue> => {
        const snippet = await sourceCache.readSnippet(issue.sourcePath, issue.line, contextLines);
        return {
          ...issue,
          description: describeIssue(issue),
          ...(snippet ? { sourceSnippet: snippet } : {})
        };
      })
    );
    reasons.push({
      reason: reason.reason,
      count: reason.count,
      includedCount: issues.length,
      truncated: issues.length < rows.length,
      issues
    });
  }
  return { bucket: bucket.bucket, count: bucket.count, reasons };
}

async function buildUnusedVerbDomain(
  buckets: Array<{ bucket: UnusedVerbBucket; count: number; examples: UnusedVerbFinding[] }>,
  sourceCache: SourceFileCache,
  contextLines: number,
  examplesPerReason: number
): Promise<IssueWebReportDomain> {
  const webBuckets: IssueWebReportBucket[] = [];
  for (const bucket of buckets) {
    const allowed = Math.max(0, Math.min(bucket.examples.length, examplesPerReason));
    const issues = await Promise.all(
      bucket.examples.slice(0, allowed).map(async (finding): Promise<IssueWebReportIssue> => {
        const issue = unusedVerbIssue(finding);
        const snippet = issue.sourcePath ? await sourceCache.readSnippet(issue.sourcePath, issue.line, contextLines) : undefined;
        return {
          ...issue,
          description: describeIssue(issue),
          ...(snippet ? { sourceSnippet: snippet } : {})
        };
      })
    );
    webBuckets.push({
      bucket: bucket.bucket,
      count: bucket.count,
      reasons: [
        {
          reason: bucket.bucket,
          count: bucket.count,
          includedCount: issues.length,
          truncated: issues.length < bucket.examples.length,
          issues
        }
      ]
    });
  }
  return {
    domain: "unused_verbs",
    count: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    buckets: webBuckets
  };
}

function unusedVerbIssue(finding: UnusedVerbFinding): VerbDefinitionWebFinding {
  return {
    domain: "unused_verbs",
    bucket: finding.bucket,
    refKind: "verb_definition",
    ref: `${finding.verbId} ${finding.object}:${finding.primaryName}`,
    reason: finding.bucket,
    sourceVerbId: finding.verbId,
    sourceVerbName: finding.primaryName,
    sourceObject: finding.object,
    sourcePath: finding.sourcePath ?? "",
    line: 0,
    column: 0,
    permissions: finding.permissions,
    prepositions: finding.prepositions,
    argumentSpecs: finding.argumentSpecs,
    hasExecute: finding.hasExecute,
    isProgrammatic: finding.isProgrammatic,
    callerCount: finding.callerCount,
    selfCallerCount: finding.selfCallerCount
  };
}

async function buildExternalEntrypointDomain(
  bucket: { bucket: ExternalEntrypointBucket; count: number; examples: ExternalEntrypointFinding[] },
  sourceCache: SourceFileCache,
  contextLines: number,
  examplesPerReason: number
): Promise<IssueWebReportDomain> {
  const allowed = Math.max(0, Math.min(bucket.examples.length, examplesPerReason));
  const issues = await Promise.all(
    bucket.examples.slice(0, allowed).map(async (finding): Promise<IssueWebReportIssue> => {
      const issue = externalEntrypointIssue(finding);
      const snippet = issue.sourcePath ? await sourceCache.readSnippet(issue.sourcePath, issue.line, contextLines) : undefined;
      return {
        ...issue,
        description: describeIssue(issue),
        ...(snippet ? { sourceSnippet: snippet } : {})
      };
    })
  );
  return {
    domain: "external_entrypoints",
    count: bucket.count,
    buckets: [
      {
        bucket: bucket.bucket,
        count: bucket.count,
        reasons: [
          {
            reason: bucket.bucket,
            count: bucket.count,
            includedCount: issues.length,
            truncated: issues.length < bucket.examples.length,
            issues
          }
        ]
      }
    ]
  };
}

function externalEntrypointIssue(finding: ExternalEntrypointFinding): VerbDefinitionWebFinding {
  return {
    domain: "external_entrypoints",
    bucket: finding.bucket,
    refKind: "verb_definition",
    ref: `${finding.verbId} ${finding.object}:${finding.primaryName}`,
    reason: finding.bucket,
    sourceVerbId: finding.verbId,
    sourceVerbName: finding.primaryName,
    sourceObject: finding.object,
    sourcePath: finding.sourcePath ?? "",
    line: 0,
    column: 0,
    permissions: finding.permissions,
    prepositions: finding.prepositions,
    argumentSpecs: finding.argumentSpecs,
    hasExecute: finding.hasExecute,
    isProgrammatic: finding.isProgrammatic,
    callerCount: finding.callerCount,
    selfCallerCount: finding.selfCallerCount,
    reachability: finding.reachability,
    ...(finding.entrypointKind ? { entrypointKind: finding.entrypointKind } : {}),
    ...(finding.matchedConvention ? { matchedConvention: finding.matchedConvention } : {}),
    ...(finding.evidence ? { evidence: finding.evidence } : {})
  };
}

async function buildUnprogrammedVerbDomain(
  buckets: Array<{ bucket: UnprogrammedVerbBucket; count: number; examples: UnprogrammedVerbFinding[] }>,
  sourceCache: SourceFileCache,
  contextLines: number,
  examplesPerReason: number
): Promise<IssueWebReportDomain> {
  const webBuckets: IssueWebReportBucket[] = [];
  for (const bucket of buckets) {
    const allowed = Math.max(0, Math.min(bucket.examples.length, examplesPerReason));
    const issues = await Promise.all(
      bucket.examples.slice(0, allowed).map(async (finding): Promise<IssueWebReportIssue> => {
        const issue = unprogrammedVerbIssue(finding);
        const snippet = issue.sourcePath ? await sourceCache.readSnippet(issue.sourcePath, issue.line, contextLines) : undefined;
        return {
          ...issue,
          description: describeIssue(issue),
          ...(snippet ? { sourceSnippet: snippet } : {})
        };
      })
    );
    webBuckets.push({
      bucket: bucket.bucket,
      count: bucket.count,
      reasons: [
        {
          reason: bucket.bucket,
          count: bucket.count,
          includedCount: issues.length,
          truncated: issues.length < bucket.examples.length,
          issues
        }
      ]
    });
  }
  return {
    domain: "unprogrammed_verbs",
    count: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    buckets: webBuckets
  };
}

function unprogrammedVerbIssue(finding: UnprogrammedVerbFinding): VerbDefinitionWebFinding {
  return {
    domain: "unprogrammed_verbs",
    bucket: finding.bucket,
    refKind: "verb_definition",
    ref: `${finding.verbId} ${finding.object}:${finding.primaryName}`,
    reason: finding.bucket,
    sourceVerbId: finding.verbId,
    sourceVerbName: finding.primaryName,
    sourceObject: finding.object,
    sourcePath: finding.sourcePath ?? "",
    line: 0,
    column: 0,
    permissions: finding.permissions,
    prepositions: finding.prepositions,
    argumentSpecs: finding.argumentSpecs,
    hasExecute: finding.hasExecute,
    isProgrammatic: finding.isProgrammatic,
    callerCount: finding.callerCount,
    selfCallerCount: finding.selfCallerCount
  };
}

async function buildCodeInsightsDomain(
  buckets: Array<{ bucket: CodeInsightBucket; count: number; examples: CodeInsightFinding[] }>,
  sourceCache: SourceFileCache,
  contextLines: number,
  examplesPerReason: number
): Promise<IssueWebReportDomain> {
  const webBuckets: IssueWebReportBucket[] = [];
  for (const bucket of buckets) {
    const allowed = Math.max(0, Math.min(bucket.examples.length, examplesPerReason));
    const issues = await Promise.all(
      bucket.examples.slice(0, allowed).map(async (finding): Promise<IssueWebReportIssue> => {
        const issue: CodeInsightWebFinding = { ...finding, domain: "code_insights" };
        const snippet = issue.sourcePath ? await sourceCache.readSnippet(issue.sourcePath, issue.line, contextLines) : undefined;
        return {
          ...issue,
          description: describeIssue(issue),
          ...(snippet ? { sourceSnippet: snippet } : {})
        };
      })
    );
    webBuckets.push({
      bucket: bucket.bucket,
      count: bucket.count,
      reasons: [
        {
          reason: bucket.bucket,
          count: bucket.count,
          includedCount: issues.length,
          truncated: issues.length < bucket.examples.length,
          issues
        }
      ]
    });
  }
  return {
    domain: "code_insights",
    count: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    buckets: webBuckets
  };
}

async function buildMutationInvariantsDomain(
  buckets: Array<{ bucket: MutationInvariantBucket; count: number; examples: MutationInvariantFinding[] }>,
  sourceCache: SourceFileCache,
  contextLines: number,
  examplesPerReason: number
): Promise<IssueWebReportDomain> {
  const webBuckets: IssueWebReportBucket[] = [];
  for (const bucket of buckets) {
    const allowed = Math.max(0, Math.min(bucket.examples.length, examplesPerReason));
    const issues = await Promise.all(
      bucket.examples.slice(0, allowed).map(async (finding): Promise<IssueWebReportIssue> => {
        const issue: MutationInvariantWebFinding = { ...finding, domain: "mutation_invariants", receiverObject: finding.targetObject };
        const snippet = issue.sourcePath ? await sourceCache.readSnippet(issue.sourcePath, issue.line, contextLines) : undefined;
        return {
          ...issue,
          description: describeIssue(issue),
          ...(snippet ? { sourceSnippet: snippet } : {})
        };
      })
    );
    webBuckets.push({
      bucket: bucket.bucket,
      count: bucket.count,
      reasons: [
        {
          reason: bucket.bucket,
          count: bucket.count,
          includedCount: issues.length,
          truncated: issues.length < bucket.examples.length,
          issues
        }
      ]
    });
  }
  return {
    domain: "mutation_invariants",
    count: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    buckets: webBuckets
  };
}

export function formatIssueWebReportHtml(report: IssueWebReport): string {
  const reportJson = JSON.stringify(report).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MOO Code Graph Issues</title>
<style>
:root{color-scheme:light;--bg:#f6f7f9;--panel:#fff;--line:#d8dde6;--text:#1f2933;--muted:#667085;--accent:#0f766e;--bad:#b42318;--warn:#b54708;--info:#175cd3;--code:#111827}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--panel);border-bottom:1px solid var(--line);padding:16px 24px}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:18px;margin:28px 0 10px}
h3{font-size:15px;margin:0}
main{padding:18px 24px 40px;max-width:1400px;margin:0 auto}
.meta,.controls,.summary,.reason,.issue{background:var(--panel);border:1px solid var(--line);border-radius:8px}
.meta{padding:12px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-top:12px}
.meta div,.issue-meta div{min-width:0}
.label{display:block;color:var(--muted);font-size:12px}
.value{font-weight:600;overflow-wrap:anywhere}
.controls{padding:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin:16px 0}
input,select{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--text)}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
.tab{border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:8px 10px;color:var(--text);cursor:pointer}
.tab.active{border-color:var(--accent);box-shadow:inset 0 -2px 0 var(--accent);font-weight:700}
.summary{padding:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.summary-card{border-left:4px solid var(--accent);padding-left:10px}
.summary-card.missing_core_reference{border-color:var(--bad)}
.summary-card.missing_core_target_object{border-color:var(--bad)}
.summary-card.missing_object{border-color:var(--bad)}
.summary-card.missing_verb{border-color:var(--bad)}
.summary-card.invalid_property_reference{border-color:var(--bad)}
.summary-card.definite_issue{border-color:var(--bad)}
.summary-card.handled_inline_issue{border-color:var(--accent)}
.summary-card.optional_composition_hook{border-color:var(--accent)}
.summary-card.guarded_runtime_property{border-color:var(--info)}
.summary-card.guarded_runtime_verb{border-color:var(--info)}
.summary-card.runtime_universal_property{border-color:var(--info)}
.summary-card.runtime_dependent{border-color:var(--warn)}
.summary-card.model_gap{border-color:var(--info)}
.summary-card.candidate_miss{border-color:var(--accent)}
.summary-card.server_or_convention_entrypoint{border-color:var(--info)}
.summary-card.no_static_callers{border-color:var(--warn)}
.summary-card.non_execute_helper{border-color:var(--muted)}
.summary-card.programmatic_stub{border-color:var(--warn)}
.summary-card.command_stub{border-color:var(--info)}
.summary-card.non_executable_placeholder{border-color:var(--muted)}
.count{font-size:24px;font-weight:700}
.reason{margin:14px 0;padding:14px}
.reason-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted);font-size:12px}
.issue{padding:12px;margin:10px 0}
.issue-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.ref{font:600 14px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--code);overflow-wrap:anywhere}
.desc{margin:8px 0;color:var(--text)}
.issue-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px;margin:8px 0}
pre{margin:10px 0 0;overflow:auto;background:#101828;color:#eaecf0;border-radius:8px;padding:10px}
code{font:13px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace}
.line{display:grid;grid-template-columns:54px minmax(0,1fr);gap:10px;white-space:pre;min-height:0}
.line-text{white-space:pre}
.line-no{color:#98a2b3;text-align:right;user-select:none}
.hit{background:#344054}
.hidden{display:none}
.empty{color:var(--muted);padding:20px;text-align:center}
.truncated{color:var(--warn);font-weight:600}
</style>
</head>
<body>
<header>
  <h1>MOO Code Graph Issues</h1>
  <div>${escapeHtml(report.resolvedDir)}</div>
  <div class="meta">
    <div><span class="label">Total issues</span><span class="value">${report.total}</span></div>
    <div><span class="label">Rendered issues</span><span class="value">${report.includedIssueCount}</span></div>
    <div><span class="label">Generated</span><span class="value">${escapeHtml(report.generatedAt)}</span></div>
    <div><span class="label">Source extract</span><span class="value">${escapeHtml(report.sourceExtractDir ?? "unknown")}</span></div>
  </div>
</header>
<main>
  ${
    report.truncated
      ? `<p class="truncated">This report is truncated. Increase --examples-per-reason or --max-issues to render more issue cards.</p>`
      : ""
  }
  <section class="controls" aria-label="Filters">
    <label><span class="label">Search</span><input id="search" type="search" placeholder="ref, source verb, path, reason, code"></label>
    <label><span class="label">Bucket</span><select id="bucket"><option value="">All buckets</option>${bucketOptions(report)}</select></label>
    <label><span class="label">Reason</span><select id="reason"><option value="">All reasons</option>${reasonOptions(report)}</select></label>
  </section>
  <section class="tabs" aria-label="Issue views">${report.domains.map(formatDomainTab).join("")}</section>
  <section class="summary">${report.domains.flatMap((domain) => domain.buckets.map((bucket) => formatBucketSummary(domain.domain, bucket))).join("")}</section>
  <section id="issues">${report.domains.flatMap((domain) => domain.buckets.map((bucket) => formatBucket(domain.domain, bucket))).join("")}</section>
  <div id="empty" class="empty hidden">No rendered issues match the current filters.</div>
</main>
<script id="report-data" type="application/json">${reportJson}</script>
<script>
const search = document.getElementById("search");
const bucket = document.getElementById("bucket");
const reason = document.getElementById("reason");
const empty = document.getElementById("empty");
const reportData = JSON.parse(document.getElementById("report-data").textContent);
const tabs = [...document.querySelectorAll(".tab")];
let activeDomain = tabs[0]?.dataset.domain || "moo_bug";
const issueCards = [...document.querySelectorAll(".issue")];
const reasons = [...document.querySelectorAll(".reason")];
const buckets = [...document.querySelectorAll(".bucket")];
const summaries = [...document.querySelectorAll(".summary-card")];
function activeDomainReport(){
  return reportData.domains.find((domain) => domain.domain === activeDomain) || reportData.domains[0];
}
function appendOption(select, value, label){
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}
function updateBucketOptions(){
  const previous = bucket.value;
  const domain = activeDomainReport();
  const available = new Set();
  bucket.replaceChildren();
  appendOption(bucket, "", "All buckets (" + (domain?.count || 0) + ")");
  for (const item of domain?.buckets || []) {
    if (item.count <= 0) continue;
    available.add(item.bucket);
    appendOption(bucket, item.bucket, item.bucket + " (" + item.count + ")");
  }
  bucket.value = available.has(previous) ? previous : "";
}
function updateReasonOptions(){
  const previous = reason.value;
  const domain = activeDomainReport();
  const selectedBucket = bucket.value;
  const counts = new Map();
  for (const item of domain?.buckets || []) {
    if (selectedBucket && item.bucket !== selectedBucket) continue;
    for (const group of item.reasons || []) {
      if (group.count <= 0) continue;
      counts.set(group.reason, (counts.get(group.reason) || 0) + group.count);
    }
  }
  reason.replaceChildren();
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  appendOption(reason, "", "All reasons (" + total + ")");
  for (const [name, count] of [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    appendOption(reason, name, name + " (" + count + ")");
  }
  reason.value = counts.has(previous) ? previous : "";
}
function updateFilterOptions(){
  updateBucketOptions();
  updateReasonOptions();
}
function applyFilters(){
  const q = search.value.trim().toLowerCase();
  const b = bucket.value;
  const r = reason.value;
  let visible = 0;
  for (const tab of tabs) tab.classList.toggle("active", tab.dataset.domain === activeDomain);
  for (const summary of summaries) summary.classList.toggle("hidden", summary.dataset.domain !== activeDomain);
  for (const card of issueCards) {
    const ok = card.dataset.domain === activeDomain && (!b || card.dataset.bucket === b) && (!r || card.dataset.reason === r) && (!q || card.dataset.search.includes(q));
    card.classList.toggle("hidden", !ok);
    if (ok) visible += 1;
  }
  for (const group of reasons) {
    const any = group.dataset.domain === activeDomain && [...group.querySelectorAll(".issue")].some((card) => !card.classList.contains("hidden"));
    group.classList.toggle("hidden", !any);
  }
  for (const group of buckets) {
    const any = group.dataset.domain === activeDomain && [...group.querySelectorAll(".reason")].some((reason) => !reason.classList.contains("hidden"));
    group.classList.toggle("hidden", !any);
  }
  empty.classList.toggle("hidden", visible !== 0);
}
for (const tab of tabs) tab.addEventListener("click", () => { activeDomain = tab.dataset.domain; updateFilterOptions(); applyFilters(); });
search.addEventListener("input", applyFilters);
bucket.addEventListener("change", () => { updateReasonOptions(); applyFilters(); });
reason.addEventListener("change", applyFilters);
updateFilterOptions();
applyFilters();
</script>
</body>
</html>`;
}

export async function serveIssueWebReport(options: ServeIssueWebReportOptions): Promise<ServedIssueWebReport> {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const report = await buildIssueWebReport(options);
  const html = formatIssueWebReportHtml(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;

  const server = createServer((request, response) => {
    const path = request.url?.split("?", 1)[0] ?? "/";
    if (path === "/" || path === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (path === "/report.json") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(json);
      return;
    }
    if (path === "/healthz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, resolvedDir: report.resolvedDir }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : requestedPort;
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  return {
    server,
    host,
    port: actualPort,
    url: `http://${displayHost}:${actualPort}/`,
    report,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

export function describeIssue(
  issue: {
    bucket: string;
    refKind: string;
    ref: string;
    reason: string;
    receiverObject?: string;
    inlineErrorHandled?: boolean;
    inlineErrorCodes?: string[];
    property?: string;
    guardText?: string;
    matchedConvention?: string;
    evidence?: string;
    callerCount?: number;
    reachability?: string[];
    cyclomaticComplexity?: number;
    nonBlankLineCount?: number;
    maxControlFlowDepth?: number;
    statementCount?: number;
    variableName?: string;
    bindingKind?: string;
    dbShape?: string;
    rhsShape?: string;
    rightText?: string;
    effectiveValueObject?: string;
    effectiveValuePreview?: string;
  }
): string {
  if (issue.refKind === "identifier_binding") {
    if (issue.reason === "dead_store") return `${issue.variableName ?? issue.ref} is assigned and then overwritten before any read in the same verb.`;
    if (issue.reason === "write_only_variable") return `${issue.variableName ?? issue.ref} is assigned multiple times but never read in the same verb.`;
    if (issue.reason === "unused_loop_variable") return `${issue.variableName ?? issue.ref} is bound as a loop variable but is never read in the same verb.`;
    if (issue.reason === "unused_destructuring_binding") {
      return `${issue.variableName ?? issue.ref} is bound by destructuring but is never read in the same verb.`;
    }
    return `${issue.variableName ?? issue.ref} is assigned but is never read in the same verb.`;
  }
  if (issue.refKind === "verb_metric") {
    if (issue.reason === "high_complexity") {
      return `${issue.ref} has cyclomatic complexity ${issue.cyclomaticComplexity ?? "unknown"}, which makes it a review and refactoring candidate.`;
    }
    if (issue.reason === "large_verb") {
      return `${issue.ref} has ${issue.nonBlankLineCount ?? "unknown"} non-blank source lines, which makes it harder to scan and safely change.`;
    }
    if (issue.reason === "deep_nesting") {
      return `${issue.ref} reaches control-flow nesting depth ${issue.maxControlFlowDepth ?? "unknown"}, which raises branch reasoning cost.`;
    }
    return `${issue.ref} has code metrics worth reviewing.`;
  }
  if (issue.refKind === "verb_aggregate") {
    if (issue.reason === "argument_heavy") return `${issue.ref} heavily references command argument variables.`;
    if (issue.reason === "mutation_heavy") return `${issue.ref} writes many object properties.`;
    if (issue.reason === "dynamic_dispatch_hotspot") return `${issue.ref} uses dynamic verb or computed property dispatch frequently.`;
    if (issue.reason === "broad_coupling") return `${issue.ref} touches a broad set of calls, properties, functions, or system objects.`;
    if (issue.reason === "error_handling_heavy") return `${issue.ref} has a high amount of try or inline-error handling.`;
    return `${issue.ref} has aggregate code metrics worth reviewing.`;
  }
  if (issue.refKind === "literal_string") return `${issue.ref} repeats the same literal string several times.`;
  if (issue.refKind === "similar_verb") return `${issue.ref} has the same normalized body shape as another programmed verb.`;
  if (issue.refKind === "property_write") {
    return `${issue.ref} writes ${issue.rhsShape ?? "unknown"} into a property whose effective DB value is ${issue.dbShape ?? "unknown"} from ${issue.effectiveValueObject ?? "unknown"}; current value is ${issue.effectiveValuePreview ?? "unknown"}.`;
  }
  if (issue.refKind === "verb_definition") {
    if (issue.reason === "server_or_convention_entrypoint") {
      const staticCallers = issue.callerCount && issue.callerCount > 0 ? ` It also has ${issue.callerCount} resolved static MOO caller${issue.callerCount === 1 ? "" : "s"}.` : "";
      return `${issue.ref} is externally reachable because it matches ${issue.matchedConvention ?? "a known server or framework entrypoint"}.${staticCallers} ${issue.evidence ?? ""}`;
    }
    if (issue.reason === "non_execute_helper") {
      return `${issue.ref} is a programmed this-none-this helper with no resolved static callers, but it is not +x.`;
    }
    if (issue.reason === "programmatic_stub") {
      return `${issue.ref} is a this-none-this verb definition with no stored program body.`;
    }
    if (issue.reason === "command_stub") {
      return `${issue.ref} is an executable command-shaped verb definition with no stored program body.`;
    }
    if (issue.reason === "non_executable_placeholder") {
      return `${issue.ref} is a non-executable verb definition with no stored program body.`;
    }
    return `${issue.ref} is a programmed this-none-this +x verb with no resolved static callers. This is a dead-code candidate, not a proof of dead code.`;
  }
  if (issue.refKind === "system_object") {
    if (issue.reason === "no_core_candidate") return `${issue.ref} has no core candidate or #0 root property.`;
    if (issue.reason === "core_candidate_missing_target_object") return `${issue.ref} points at missing object ${issue.receiverObject ?? "unknown"}.`;
    return `${issue.ref} could not be resolved as a system object.`;
  }
  if (issue.refKind === "literal_object") return `${issue.ref} references an object that is missing from the extract.`;
  if (issue.bucket === "guarded_runtime_verb") {
    return `${issue.ref} is validated by local callable-verb guard ${issue.guardText ?? ""}, but is not backed by a static verb candidate.`;
  }
  if (issue.bucket === "optional_composition_hook") {
    return `${issue.ref} is an optional feature hook broadcast over known feature objects with no implementor in this snapshot.`;
  }
  if (issue.refKind === "verb_call") {
    if (issue.inlineErrorHandled) {
      const codes = issue.inlineErrorCodes?.length ? issue.inlineErrorCodes.join(", ") : "inline errors";
      return `${issue.ref} is unresolved, but the call is protected by inline error handling for ${codes}.`;
    }
    if (issue.reason === "no_core_candidate") return `${issue.ref} calls through an unresolved $core receiver.`;
    if (issue.reason === "no_matching_direct_or_inherited_verb") return `${issue.ref} has no matching direct or inherited verb candidate.`;
    if (issue.reason === "missing_object") return `${issue.ref} calls a missing literal object.`;
    return `${issue.ref} could not be resolved to a verb candidate.`;
  }
  if (issue.refKind === "property_access" && issue.inlineErrorHandled) {
    const codes = issue.inlineErrorCodes?.length ? issue.inlineErrorCodes.join(", ") : "inline errors";
    return `${issue.ref} is unresolved, but the property access is protected by inline error handling for ${codes}.`;
  }
  if (issue.bucket === "runtime_universal_property") {
    return `${issue.ref} uses known universal object property .${issue.property ?? "unknown"} on a runtime receiver; the receiver identity is not statically known.`;
  }
  if (issue.bucket === "guarded_runtime_property") {
    return `${issue.ref} is validated by local guard ${issue.guardText ?? ""}, but is not backed by static extracted property metadata.`;
  }
  if (issue.reason === "no_matching_property") return `${issue.ref} has no matching direct or inherited property candidate.`;
  if (issue.reason === "missing_object") return `${issue.ref} reads or writes a missing literal object.`;
  if (issue.reason === "dynamic_property") return `${issue.ref} uses a computed property name and remains dynamic.`;
  if (issue.reason === "runtime_property_chain_receiver") {
    return `${issue.ref} follows a property chain rooted in a runtime receiver, so the concrete receiver object is not statically known.`;
  }
  return `${issue.ref} could not be resolved as a property access.`;
}

function formatDomainTab(domain: IssueWebReportDomain): string {
  return `<button type="button" class="tab" data-domain="${escapeAttribute(domain.domain)}">${escapeHtml(domainLabel(domain.domain))} (${domain.count})</button>`;
}

function formatBucketSummary(domain: IssueWebReportDomainKey, bucket: IssueWebReportBucket): string {
  return `<div class="summary-card ${escapeAttribute(bucket.bucket)}" data-domain="${escapeAttribute(domain)}"><span class="label">${escapeHtml(bucketLabel(bucket.bucket))}</span><div class="count">${bucket.count}</div></div>`;
}

function formatBucket(domain: IssueWebReportDomainKey, bucket: IssueWebReportBucket): string {
  if (bucket.count === 0) return "";
  return `<section class="bucket" data-domain="${escapeAttribute(domain)}" data-bucket="${escapeAttribute(bucket.bucket)}"><h2>${escapeHtml(bucketLabel(bucket.bucket))} (${bucket.count})</h2>${bucket.reasons
    .filter((reason) => reason.count > 0)
    .map((reason) => formatReason(domain, bucket.bucket, reason))
    .join("")}</section>`;
}

function formatReason(domain: IssueWebReportDomainKey, bucket: IssueWebReportBucketKey, reason: IssueWebReportReasonGroup): string {
  return `<section class="reason" data-domain="${escapeAttribute(domain)}" data-bucket="${escapeAttribute(bucket)}" data-reason="${escapeAttribute(reason.reason)}">
  <div class="reason-head"><h3>${escapeHtml(reason.reason)} (${reason.count})</h3><span class="badge">${reason.includedCount} shown${reason.truncated ? " / truncated" : ""}</span></div>
  ${reason.issues.map((issue) => formatIssue(domain, bucket, reason.reason, issue)).join("")}
</section>`;
}

function formatIssue(domain: IssueWebReportDomainKey, bucket: IssueWebReportBucketKey, reason: string, issue: IssueWebReportIssue): string {
  const searchText = [
    domain,
    bucket,
    reason,
    issue.ref,
    issue.sourceVerbId,
    issue.sourceVerbName ?? "",
    issue.sourceObject,
    issue.sourcePath,
    issue.sourceLine ?? "",
    issue.description,
    ...(issue.inlineErrorCodes ?? []),
    issue.inlineErrorFallbackText ?? "",
    issue.inlineErrorExpressionText ?? "",
    issue.guardText ?? "",
    issue.guardScope ?? "",
    issue.refKind === "verb_definition" ? issue.permissions.join(" ") : "",
    issue.refKind === "verb_definition" ? issue.prepositions.join(" ") : "",
    issue.refKind === "verb_definition" ? issue.argumentSpecs.join(" ") : "",
    issue.refKind === "verb_definition" ? issue.entrypointKind ?? "" : "",
    issue.refKind === "verb_definition" ? issue.matchedConvention ?? "" : "",
    issue.refKind === "verb_definition" ? issue.evidence ?? "" : "",
    issue.refKind === "verb_definition" ? issue.reachability?.join(" ") ?? "" : "",
    issue.refKind === "verb_metric" ? `${issue.cyclomaticComplexity} ${issue.nonBlankLineCount} ${issue.maxControlFlowDepth} ${issue.statementCount}` : "",
    issue.refKind === "identifier_binding" ? `${issue.variableName ?? ""} ${issue.bindingKind ?? ""}` : "",
    issue.refKind === "property_write" ? `${issue.property ?? ""} ${issue.receiverObject ?? ""} ${issue.dbShape ?? ""} ${issue.rhsShape ?? ""} ${issue.rightText ?? ""} ${issue.effectiveValuePreview ?? ""}` : "",
    "count" in issue ? `${issue.count ?? ""} ${issue.distinctCount ?? ""} ${issue.detail ?? ""} ${issue.repeatedValue ?? ""}` : ""
  ]
    .join(" ")
    .toLowerCase();
  return `<article class="issue" data-domain="${escapeAttribute(domain)}" data-bucket="${escapeAttribute(bucket)}" data-reason="${escapeAttribute(reason)}" data-search="${escapeAttribute(searchText)}">
  <div class="issue-title"><div class="ref">${escapeHtml(issue.ref)}</div><span class="badge">${escapeHtml(issue.refKind)}</span></div>
  <p class="desc">${escapeHtml(issue.description)}</p>
  <div class="issue-meta">
    <div><span class="label">Source verb</span><span class="value">${escapeHtml(sourceVerbLabel(issue))}</span></div>
    <div><span class="label">Location</span><span class="value">${escapeHtml(issue.sourcePath ? `${issue.sourcePath}:${issue.line}:${issue.column}` : "no source path")}</span></div>
    <div><span class="label">Reason</span><span class="value">${escapeHtml(issue.reason)}</span></div>
    ${issue.refKind === "verb_definition" ? `<div><span class="label">Permissions</span><span class="value">${escapeHtml(issue.permissions.join(", ") || "none")}</span></div>` : ""}
    ${issue.refKind === "verb_definition" ? `<div><span class="label">Argument specs</span><span class="value">${escapeHtml(issue.argumentSpecs.join(" "))}</span></div>` : ""}
    ${issue.refKind === "verb_definition" ? `<div><span class="label">Resolved callers</span><span class="value">${issue.callerCount}</span></div>` : ""}
    ${issue.refKind === "verb_metric" ? `<div><span class="label">Complexity</span><span class="value">${issue.cyclomaticComplexity}</span></div>` : ""}
    ${issue.refKind === "verb_metric" ? `<div><span class="label">Non-blank lines</span><span class="value">${issue.nonBlankLineCount}</span></div>` : ""}
    ${issue.refKind === "verb_metric" ? `<div><span class="label">Nesting depth</span><span class="value">${issue.maxControlFlowDepth}</span></div>` : ""}
    ${issue.refKind === "verb_metric" ? `<div><span class="label">Statements</span><span class="value">${issue.statementCount}</span></div>` : ""}
    ${issue.refKind === "identifier_binding" ? `<div><span class="label">Variable</span><span class="value">${escapeHtml(issue.variableName ?? "")}</span></div>` : ""}
    ${issue.refKind === "identifier_binding" ? `<div><span class="label">Binding</span><span class="value">${escapeHtml(issue.bindingKind ?? "")}</span></div>` : ""}
    ${issue.refKind === "property_write" ? `<div><span class="label">DB shape</span><span class="value">${escapeHtml(issue.dbShape)}</span></div>` : ""}
    ${issue.refKind === "property_write" ? `<div><span class="label">RHS shape</span><span class="value">${escapeHtml(issue.rhsShape)}</span></div>` : ""}
    ${issue.refKind === "property_write" ? `<div><span class="label">RHS</span><span class="value">${escapeHtml(issue.rightText)}</span></div>` : ""}
    ${issue.refKind === "property_write" ? `<div><span class="label">Current value</span><span class="value">${escapeHtml(issue.effectiveValuePreview)}</span></div>` : ""}
    ${issue.refKind === "property_write" ? `<div><span class="label">Effective value</span><span class="value">${escapeHtml(`${issue.effectiveValueObject} (${issue.effectiveValueSource})`)}</span></div>` : ""}
    ${"count" in issue && issue.count !== undefined ? `<div><span class="label">Count</span><span class="value">${issue.count}</span></div>` : ""}
    ${"distinctCount" in issue && issue.distinctCount !== undefined ? `<div><span class="label">Distinct</span><span class="value">${issue.distinctCount}</span></div>` : ""}
    ${"detail" in issue && issue.detail ? `<div><span class="label">Detail</span><span class="value">${escapeHtml(issue.detail)}</span></div>` : ""}
    ${"relatedSourceVerbId" in issue && issue.relatedSourceVerbId ? `<div><span class="label">Related</span><span class="value">${escapeHtml(`${issue.relatedSourceObject ?? "?"}:${issue.relatedSourceVerbName ?? issue.relatedSourceVerbId}`)}</span></div>` : ""}
    ${issue.refKind === "verb_definition" && issue.reachability ? `<div><span class="label">Reachability</span><span class="value">${escapeHtml(issue.reachability.join(", "))}</span></div>` : ""}
    ${issue.refKind === "verb_definition" && issue.entrypointKind ? `<div><span class="label">Entrypoint</span><span class="value">${escapeHtml(issue.matchedConvention ?? issue.entrypointKind)}</span></div>` : ""}
    ${issue.refKind === "verb_definition" && issue.evidence ? `<div><span class="label">Evidence</span><span class="value">${escapeHtml(issue.evidence)}</span></div>` : ""}
    ${issue.inlineErrorHandled ? `<div><span class="label">Inline catch</span><span class="value">${escapeHtml((issue.inlineErrorCodes ?? []).join(", ") || "unknown")}</span></div>` : ""}
    ${issue.guardText ? `<div><span class="label">Guard</span><span class="value">${escapeHtml(issue.guardText)}</span></div>` : ""}
    ${issue.inlineErrorFallbackText ? `<div><span class="label">Fallback</span><span class="value">${escapeHtml(issue.inlineErrorFallbackText)}</span></div>` : ""}
    ${issue.receiverObject ? `<div><span class="label">Receiver object</span><span class="value">${escapeHtml(issue.receiverObject)}</span></div>` : ""}
    ${"candidateObjects" in issue && issue.candidateObjects?.length ? `<div><span class="label">Candidate objects</span><span class="value">${escapeHtml(issue.candidateObjects.join(", "))}</span></div>` : ""}
  </div>
  ${issue.sourceSnippet ? formatSnippet(issue.sourceSnippet) : ""}
</article>`;
}

function domainLabel(domain: IssueWebReportDomainKey): string {
  if (domain === "unused_verbs") return "Unused Verbs";
  if (domain === "external_entrypoints") return "External Entrypoints";
  if (domain === "unprogrammed_verbs") return "Unprogrammed Verbs";
  if (domain === "code_insights") return "Code Improvements";
  if (domain === "mutation_invariants") return "Mutation / Invariants";
  switch (domain) {
    case "moo_bug":
      return "MOO Bugs";
    case "handled_inline":
      return "Handled Inline";
    case "graph_refinement":
      return "Dynamic Resolution";
  }
}

function bucketLabel(bucket: IssueWebReportBucketKey): string {
  if (bucket === "high_complexity") return "High Complexity";
  if (bucket === "large_verb") return "Large Verbs";
  if (bucket === "deep_nesting") return "Deep Nesting";
  if (bucket === "unused_assignment") return "Unused Assignments";
  if (bucket === "unused_loop_variable") return "Unused Loop Variables";
  if (bucket === "unused_destructuring_binding") return "Unused Destructuring Bindings";
  if (bucket === "dead_store") return "Dead Stores";
  if (bucket === "write_only_variable") return "Write-Only Variables";
  if (bucket === "argument_heavy") return "Argument-Heavy Verbs";
  if (bucket === "mutation_heavy") return "Mutation-Heavy Verbs";
  if (bucket === "dynamic_dispatch_hotspot") return "Dynamic Dispatch Hotspots";
  if (bucket === "broad_coupling") return "Broad Coupling";
  if (bucket === "error_handling_heavy") return "Error-Handling Heavy";
  if (bucket === "repeated_literal_string") return "Repeated Literal Strings";
  if (bucket === "similar_verb_body") return "Similar Verb Bodies";
  if (bucket === "sensitive_shape_mismatch") return "Sensitive Shape Mismatches";
  if (bucket === "object_scalar_mismatch") return "Object/Scalar Mismatches";
  if (bucket === "collection_shape_mismatch") return "Collection Shape Mismatches";
  if (bucket === "shape_mismatch") return "Shape Mismatches";
  if (bucket === "server_or_convention_entrypoint") return "Server/Convention Entrypoints";
  if (bucket === "no_static_callers") return "No Static Callers";
  if (bucket === "non_execute_helper") return "Non-Execute Helpers";
  if (bucket === "programmatic_stub") return "Programmatic Stubs";
  if (bucket === "command_stub") return "Command Stubs";
  if (bucket === "non_executable_placeholder") return "Non-Executable Placeholders";
  switch (bucket) {
    case "missing_core_reference":
      return "Missing Core References";
    case "missing_core_target_object":
      return "Missing Core Target Objects";
    case "missing_object":
      return "Missing Objects";
    case "missing_verb":
      return "Missing Verbs";
    case "invalid_property_reference":
      return "Invalid Property References";
    case "definite_issue":
      return "Definite Issues";
    case "handled_inline_issue":
      return "Handled Inline Issues";
    case "optional_composition_hook":
      return "Optional Composition Hooks";
    case "guarded_runtime_property":
      return "Guarded Runtime Properties";
    case "guarded_runtime_verb":
      return "Guarded Runtime Verbs";
    case "runtime_universal_property":
      return "Runtime Universal Properties";
    case "runtime_dependent":
      return "Runtime Dependent";
    case "model_gap":
      return "Model Gaps";
    case "candidate_miss":
      return "Candidate Misses";
  }
  return String(bucket);
}

function formatSnippet(snippet: IssueWebReportSnippet): string {
  return `<pre><code>${snippet.lines
    .map(
      (line) =>
        `<span class="line${line.highlight ? " hit" : ""}"><span class="line-no">${line.line + 1}</span><span class="line-text">${escapeHtml(line.text)}</span></span>`
    )
    .join("")}</code></pre>`;
}

function sourceVerbLabel(issue: IssueWebReportIssue): string {
  if (issue.refKind === "verb_definition") return `${issue.sourceObject}:${issue.sourceVerbName ?? issue.sourceVerbId} (${issue.sourceVerbId})`;
  return `${issue.sourceObject}:${issue.sourceVerbName ?? issue.sourceVerbId} (${issue.sourceVerbId})`;
}

function bucketOptions(report: IssueWebReport): string {
  return report.buckets
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => `<option value="${escapeAttribute(bucket.bucket)}">${escapeHtml(`${bucket.bucket} (${bucket.count})`)}</option>`)
    .join("");
}

function reasonOptions(report: IssueWebReport): string {
  const reasons = new Map<string, number>();
  for (const bucket of report.buckets) {
    for (const reason of bucket.reasons) {
      if (reason.count > 0) reasons.set(reason.reason, (reasons.get(reason.reason) ?? 0) + reason.count);
    }
  }
  return [...reasons.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `<option value="${escapeAttribute(reason)}">${escapeHtml(`${reason} (${count})`)}</option>`)
    .join("");
}

function escapeHtml(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string | number): string {
  return escapeHtml(value).replaceAll("\n", " ");
}

class SourceFileCache {
  private readonly files = new Map<string, Promise<string[]>>();

  constructor(private readonly extractDir: string | undefined) {}

  async readSnippet(sourcePath: string, targetLine: number, contextLines: number): Promise<IssueWebReportSnippet | undefined> {
    if (!this.extractDir) return undefined;
    const lines = await this.readLines(sourcePath);
    if (!lines) return undefined;
    const startLine = Math.max(0, targetLine - contextLines);
    const endLine = Math.min(lines.length - 1, targetLine + contextLines);
    return {
      sourcePath,
      startLine,
      endLine,
      targetLine,
      lines: lines.slice(startLine, endLine + 1).map((text, index) => {
        const line = startLine + index;
        return { line, text, highlight: line === targetLine };
      })
    };
  }

  private async readLines(sourcePath: string): Promise<string[] | undefined> {
    let pending = this.files.get(sourcePath);
    if (!pending) {
      pending = readFile(join(this.extractDir!, sourcePath), "utf8").then((source) => source.split(/\r?\n/));
      this.files.set(sourcePath, pending);
    }
    try {
      return await pending;
    } catch {
      return undefined;
    }
  }
}
