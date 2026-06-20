import { loadVerbs } from "../load/loadVerbs.js";
import { loadResolvedGraph } from "../query/queryResolvedGraph.js";
import { hasExecute, isProgrammaticVerb, sourceExtractDirFromManifest, verbFindingBase } from "./reportUnusedVerbs.js";

export type UnprogrammedVerbBucket = "programmatic_stub" | "command_stub" | "non_executable_placeholder";

export interface ReportUnprogrammedVerbsOptions {
  resolvedDir: string;
  extractDir?: string;
  examplesPerBucket?: number;
}

export interface UnprogrammedVerbFinding {
  bucket: UnprogrammedVerbBucket;
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

export interface UnprogrammedVerbBucketSummary {
  bucket: UnprogrammedVerbBucket;
  count: number;
  examples: UnprogrammedVerbFinding[];
}

export interface UnprogrammedVerbsReport {
  resolvedDir: string;
  extractDir: string;
  examplesPerBucket: number;
  totalVerbCount: number;
  programmedVerbCount: number;
  unprogrammedVerbCount: number;
  buckets: UnprogrammedVerbBucketSummary[];
}

export async function reportUnprogrammedVerbs(options: ReportUnprogrammedVerbsOptions): Promise<UnprogrammedVerbsReport> {
  const graph = await loadResolvedGraph(options.resolvedDir);
  const extractDir = options.extractDir ?? sourceExtractDirFromManifest(graph.manifest);
  if (!extractDir) {
    throw new Error("report unprogrammed-verbs requires --extract when resolved manifest has no sourceExtractDir");
  }

  const examplesPerBucket = options.examplesPerBucket ?? 25;
  const verbs = await loadVerbs(extractDir);
  const findings = verbs
    .filter((verb) => !verb.hasProgram)
    .map((verb): UnprogrammedVerbFinding => {
      const base = verbFindingBase(verb, { total: 0, self: 0 });
      return {
        bucket: unprogrammedBucket(verb),
        ...base
      };
    })
    .sort((left, right) => left.object.localeCompare(right.object) || left.verbIndex - right.verbIndex || left.verbId.localeCompare(right.verbId));

  return {
    resolvedDir: options.resolvedDir,
    extractDir,
    examplesPerBucket,
    totalVerbCount: verbs.length,
    programmedVerbCount: verbs.length - findings.length,
    unprogrammedVerbCount: findings.length,
    buckets: summarizeBuckets(findings, examplesPerBucket)
  };
}

export function formatUnprogrammedVerbsReport(report: UnprogrammedVerbsReport): string {
  const lines = [
    `Unprogrammed verbs: ${report.unprogrammedVerbCount}`,
    `  total verbs: ${report.totalVerbCount}`,
    `  programmed verbs: ${report.programmedVerbCount}`
  ];
  for (const bucket of report.buckets) {
    if (bucket.count === 0) continue;
    lines.push("");
    lines.push(`${bucket.bucket}: ${bucket.count}`);
    for (const finding of bucket.examples) {
      const names = finding.names.length > 0 ? finding.names.join(" ") : finding.primaryName;
      lines.push(`  ${finding.verbId} ${finding.object}:${names} [${finding.permissions.join(",") || "no-perms"}; args=${finding.argumentSpecs.join(" ")}]`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function unprogrammedBucket(verb: Parameters<typeof verbFindingBase>[0]): UnprogrammedVerbBucket {
  if (!hasExecute(verb)) return "non_executable_placeholder";
  if (isProgrammaticVerb(verb)) return "programmatic_stub";
  return "command_stub";
}

function summarizeBuckets(findings: UnprogrammedVerbFinding[], examplesPerBucket: number): UnprogrammedVerbBucketSummary[] {
  return (["programmatic_stub", "command_stub", "non_executable_placeholder"] as const).map((bucket) => {
    const rows = findings.filter((finding) => finding.bucket === bucket);
    return {
      bucket,
      count: rows.length,
      examples: rows.slice(0, examplesPerBucket)
    };
  });
}
