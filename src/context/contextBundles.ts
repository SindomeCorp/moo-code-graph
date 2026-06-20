import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadResolvedGraph, querySourceVerb, type SourceVerbQueryResult } from "../query/queryResolvedGraph.js";
import type { IssueFinding } from "../report/reportIssues.js";
import { reportIssues } from "../report/reportIssues.js";

export interface ContextVerbOptions {
  resolvedDir: string;
  sourceVerbId: string;
  contextLines?: number;
}

export interface ContextIssueOptions {
  resolvedDir: string;
  ref: string;
  contextLines?: number;
}

export interface SourceSnippet {
  sourcePath: string;
  startLine: number;
  lines: Array<{ line: number; text: string }>;
}

export interface VerbContextBundle {
  kind: "verb_context";
  resolvedDir: string;
  sourceVerb: SourceVerbQueryResult;
  sourceSnippet?: SourceSnippet;
}

export interface IssueContextBundle {
  kind: "issue_context";
  resolvedDir: string;
  ref: string;
  issues: IssueFinding[];
  sourceSnippets: SourceSnippet[];
}

export async function contextForVerb(options: ContextVerbOptions): Promise<VerbContextBundle> {
  const sourceVerb = await querySourceVerb({ resolvedDir: options.resolvedDir, sourceVerbId: options.sourceVerbId });
  const graph = await loadResolvedGraph(options.resolvedDir);
  const extractDir = typeof graph.manifest.sourceExtractDir === "string" ? graph.manifest.sourceExtractDir : undefined;
  const sourceSnippet =
    extractDir && sourceVerb.sourcePath
      ? await readSourceSnippet(extractDir, sourceVerb.sourcePath, 0, Number.MAX_SAFE_INTEGER)
      : undefined;
  return {
    kind: "verb_context",
    resolvedDir: options.resolvedDir,
    sourceVerb,
    ...(sourceSnippet ? { sourceSnippet } : {})
  };
}

export async function contextForIssue(options: ContextIssueOptions): Promise<IssueContextBundle> {
  const graph = await loadResolvedGraph(options.resolvedDir);
  const extractDir = typeof graph.manifest.sourceExtractDir === "string" ? graph.manifest.sourceExtractDir : undefined;
  const report = await reportIssues({ resolvedDir: options.resolvedDir, examplesPerBucket: Number.MAX_SAFE_INTEGER });
  const issues = report.buckets.flatMap((bucket) => bucket.examples).filter((issue) => issue.ref === options.ref);
  const contextLines = options.contextLines ?? 3;
  const sourceSnippets: SourceSnippet[] = [];
  if (extractDir) {
    const seen = new Set<string>();
    for (const issue of issues) {
      const key = `${issue.sourcePath}\t${issue.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const snippet = await readSourceSnippet(extractDir, issue.sourcePath, Math.max(0, issue.line - contextLines), issue.line + contextLines);
      if (snippet) sourceSnippets.push(snippet);
    }
  }
  return { kind: "issue_context", resolvedDir: options.resolvedDir, ref: options.ref, issues, sourceSnippets };
}

export function formatVerbContext(bundle: VerbContextBundle): string {
  const verb = bundle.sourceVerb;
  const lines = [`Context for ${verb.sourceObject ?? "?"}:${verb.sourceVerbName ?? verb.sourceVerbId} (${verb.sourceVerbId})`];
  if (verb.sourcePath) lines.push(`Source: ${verb.sourcePath}`);
  lines.push(`Verb candidates: ${verb.verbCallCandidateEdges.length}`);
  lines.push(`Property candidates: ${verb.propertyCandidateEdges.length}`);
  lines.push(`Unresolved verb calls: ${verb.unresolvedVerbCalls.length}`);
  lines.push(`Unresolved property accesses: ${verb.unresolvedPropertyAccesses.length}`);
  lines.push(`Local variable states: ${verb.localVariableStates.length}`);
  lines.push(`Inferred receivers: ${verb.inferredReceiverCandidates.length}`);
  appendSnippet(lines, bundle.sourceSnippet);
  return `${lines.join("\n")}\n`;
}

export function formatIssueContext(bundle: IssueContextBundle): string {
  const lines = [`Context for issue ${bundle.ref}: ${bundle.issues.length}`];
  for (const issue of bundle.issues) {
    const verb = issue.sourceVerbName ? `${issue.sourceObject}:${issue.sourceVerbName}` : issue.sourceObject;
    lines.push(`  ${issue.sourcePath}:${issue.line}:${issue.column} ${verb} [${issue.bucket}/${issue.reason}]`);
  }
  for (const snippet of bundle.sourceSnippets) appendSnippet(lines, snippet);
  return `${lines.join("\n")}\n`;
}

async function readSourceSnippet(
  extractDir: string,
  sourcePath: string,
  startLine: number,
  endLine: number
): Promise<SourceSnippet | undefined> {
  try {
    const source = await readFile(join(extractDir, sourcePath), "utf8");
    const lines = source.split(/\r?\n/);
    const actualEnd = Math.min(lines.length - 1, endLine);
    return {
      sourcePath,
      startLine,
      lines: lines.slice(startLine, actualEnd + 1).map((text, index) => ({ line: startLine + index, text }))
    };
  } catch {
    return undefined;
  }
}

function appendSnippet(lines: string[], snippet: SourceSnippet | undefined): void {
  if (!snippet) return;
  lines.push("");
  lines.push(`Source snippet: ${snippet.sourcePath}`);
  for (const line of snippet.lines) lines.push(`${line.line.toString().padStart(4, " ")}  ${line.text}`);
}
