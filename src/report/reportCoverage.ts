import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IndexStats } from "../index.js";
import type { ResolveStats, UnresolvedPropertyAccessFinding, UnresolvedVerbCallFinding } from "../resolve/types.js";

export interface ReportCoverageOptions {
  resolvedDir: string;
}

export interface CoverageReasonGroup {
  reason: string;
  count: number;
}

export interface CoverageReport {
  resolvedDir: string;
  sourceGraphDir?: string;
  sourceExtractDir?: string;
  sourceSnapshotId?: string;
  rawStats: Partial<IndexStats>;
  resolvedStats: Partial<ResolveStats>;
  resolutionRates: {
    systemObjectRefCoverage: number | null;
    literalObjectRefCoverage: number | null;
    staticVerbCallsiteCoverage: number | null;
    staticPropertyAccessCoverage: number | null;
  };
  unresolvedVerbCallsByReason: CoverageReasonGroup[];
  unresolvedPropertyAccessesByReason: CoverageReasonGroup[];
  definiteIssueCounts: {
    verbCalls: number;
    propertyAccesses: number;
  };
}

const definiteIssueReasons = new Set([
  "no_core_candidate",
  "core_candidate_missing_target_object",
  "missing_object",
  "no_matching_direct_or_inherited_verb",
  "no_matching_property",
  "ancestor_cycle"
]);

export async function reportCoverage(options: ReportCoverageOptions): Promise<CoverageReport> {
  const manifest = await readJson<Record<string, unknown>>(join(options.resolvedDir, "manifest.json"));
  const sourceGraphDir = typeof manifest.sourceGraphDir === "string" ? manifest.sourceGraphDir : undefined;
  const rawStats = sourceGraphDir ? await readJsonIfExists<Partial<IndexStats>>(join(sourceGraphDir, "code_facts", "stats.json")) : {};
  const resolvedStats = await readJson<Partial<ResolveStats>>(join(options.resolvedDir, "edges", "stats.json"));
  const unresolvedVerbCalls = await readJsonl<UnresolvedVerbCallFinding>(join(options.resolvedDir, "findings", "unresolved_verb_calls.jsonl"));
  const unresolvedProperties = await readJsonlIfExists<UnresolvedPropertyAccessFinding>(
    join(options.resolvedDir, "findings", "unresolved_property_accesses.jsonl")
  );

  return {
    resolvedDir: options.resolvedDir,
    sourceGraphDir,
    sourceExtractDir: typeof manifest.sourceExtractDir === "string" ? manifest.sourceExtractDir : undefined,
    sourceSnapshotId: typeof manifest.sourceSnapshotId === "string" ? manifest.sourceSnapshotId : undefined,
    rawStats,
    resolvedStats,
    resolutionRates: {
      systemObjectRefCoverage: rate(resolvedStats.resolvedSystemObjectRefCount, resolvedStats.systemObjectRefCount),
      literalObjectRefCoverage: rate(resolvedStats.resolvedLiteralObjectRefCount, resolvedStats.literalObjectRefCount),
      staticVerbCallsiteCoverage: rate(
        subtractCount(resolvedStats.staticVerbCallsiteCount, unresolvedVerbCalls.length),
        resolvedStats.staticVerbCallsiteCount
      ),
      staticPropertyAccessCoverage: rate(
        subtractCount(resolvedStats.staticPropertyAccessCount, unresolvedProperties.length),
        resolvedStats.staticPropertyAccessCount
      )
    },
    unresolvedVerbCallsByReason: groupReasons(unresolvedVerbCalls),
    unresolvedPropertyAccessesByReason: groupReasons(unresolvedProperties),
    definiteIssueCounts: {
      verbCalls: countDefiniteIssues(unresolvedVerbCalls),
      propertyAccesses: countDefiniteIssues(unresolvedProperties)
    }
  };
}

export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push(`Resolved dir: ${report.resolvedDir}`);
  if (report.sourceSnapshotId) lines.push(`Snapshot: ${report.sourceSnapshotId}`);
  if (report.sourceGraphDir) lines.push(`Source graph: ${report.sourceGraphDir}`);
  if (report.sourceExtractDir) lines.push(`Source extract: ${report.sourceExtractDir}`);
  lines.push("");
  lines.push("Coverage:");
  lines.push(`  system object refs: ${formatRate(report.resolutionRates.systemObjectRefCoverage)}`);
  lines.push(`  literal object refs: ${formatRate(report.resolutionRates.literalObjectRefCoverage)}`);
  lines.push(`  static verb callsites: ${formatRate(report.resolutionRates.staticVerbCallsiteCoverage)}`);
  lines.push(`  static property accesses: ${formatRate(report.resolutionRates.staticPropertyAccessCoverage)}`);
  lines.push("");
  lines.push("Counts:");
  lines.push(`  raw callsites: ${report.rawStats.callsiteCount ?? 0}`);
  lines.push(`  raw property accesses: ${report.rawStats.propertyAccessCount ?? 0}`);
  lines.push(`  static verb callsites: ${report.resolvedStats.staticVerbCallsiteCount ?? 0}`);
  lines.push(`  resolved verb candidates: ${report.resolvedStats.resolvedVerbCallCandidateCount ?? 0}`);
  lines.push(`  unresolved verb callsites: ${report.resolvedStats.unresolvedVerbCallCandidateCount ?? 0}`);
  lines.push(`  static property accesses: ${report.resolvedStats.staticPropertyAccessCount ?? 0}`);
  lines.push(`  resolved property candidates: ${report.resolvedStats.resolvedPropertyCandidateCount ?? 0}`);
  lines.push(`  unresolved property accesses: ${report.resolvedStats.unresolvedPropertyAccessCount ?? 0}`);
  lines.push("");
  lines.push("Definite issue findings:");
  lines.push(`  verb calls: ${report.definiteIssueCounts.verbCalls}`);
  lines.push(`  property accesses: ${report.definiteIssueCounts.propertyAccesses}`);

  if (report.unresolvedVerbCallsByReason.length > 0) {
    lines.push("");
    lines.push("Unresolved verb calls by reason:");
    for (const group of report.unresolvedVerbCallsByReason) lines.push(`  ${group.reason}: ${group.count}`);
  }

  if (report.unresolvedPropertyAccessesByReason.length > 0) {
    lines.push("");
    lines.push("Unresolved property accesses by reason:");
    for (const group of report.unresolvedPropertyAccessesByReason) lines.push(`  ${group.reason}: ${group.count}`);
  }

  return `${lines.join("\n")}\n`;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonIfExists<T>(path: string): Promise<T> {
  if (!existsSync(path)) return {} as T;
  return readJson<T>(path);
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function readJsonlIfExists<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  return readJsonl<T>(path);
}

function groupReasons(findings: Array<{ reason: string }>): CoverageReasonGroup[] {
  const groups = new Map<string, number>();
  for (const finding of findings) groups.set(finding.reason, (groups.get(finding.reason) ?? 0) + 1);
  return [...groups.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function countDefiniteIssues(findings: Array<{ reason: string; inlineErrorHandled?: boolean }>): number {
  return findings.filter((finding) => !finding.inlineErrorHandled && definiteIssueReasons.has(finding.reason)).length;
}

function rate(numerator: number | undefined, denominator: number | undefined): number | null {
  if (numerator === undefined || denominator === undefined || denominator <= 0) return null;
  return Math.max(0, Math.min(1, numerator / denominator));
}

function subtractCount(value: number | undefined, amount: number): number | undefined {
  return typeof value === "number" ? value - amount : undefined;
}

function formatRate(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}
