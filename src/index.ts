import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CoreCandidateRecord,
  ExtractManifest,
  ExtractedObjectRecord,
  ExtractedPropertyDefinitionRecord,
  ExtractedPropertyValueRecord,
  ExtractedVerbRecord,
  ObjectRef
} from "@sindomecorp/toaststunt-db-extractor";
import { CodeGraphError } from "./errors/CodeGraphError.js";
import { JsonlWriter } from "./emit/JsonlWriter.js";
import { writeManifest } from "./emit/ManifestWriter.js";
import { addFactsToStats, createEmptyStats } from "./emit/StatsCollector.js";
import type { ExtractedFacts, ParseErrorFact } from "./facts/types.js";
import { locationOf } from "./facts/nodeText.js";
import { extractFactsFromTree } from "./facts/extractFactsFromTree.js";
import { loadExtractManifest } from "./load/loadExtractManifest.js";
import { loadVerbs } from "./load/loadVerbs.js";
import { MooParser } from "./parser/MooParser.js";
import { parseVerbCode } from "./parser/parseVerbCode.js";
import { inspectExtractDir, type InspectResult } from "./inspect/inspectExtractDir.js";
import { validateExtractDir, type ValidationResult } from "./validate/validateExtractDir.js";
import { resolveMooCodeGraph } from "./resolve/resolveMooCodeGraph.js";
import type { ResolveMooCodeGraphOptions, ResolveProgressEvent, ResolveResult, ResolveStats } from "./resolve/types.js";
import { formatUnresolvedReport, reportUnresolved } from "./report/reportUnresolved.js";
import { formatCoverageReport, reportCoverage } from "./report/reportCoverage.js";
import { formatIssuesReport, reportIssues } from "./report/reportIssues.js";
import { formatUnusedVerbsReport, reportUnusedVerbs } from "./report/reportUnusedVerbs.js";
import { formatUnprogrammedVerbsReport, reportUnprogrammedVerbs } from "./report/reportUnprogrammedVerbs.js";
import { formatCodeInsightsReport, reportCodeInsights } from "./report/reportCodeInsights.js";
import { formatMutationInvariantsReport, reportMutationInvariants } from "./report/reportMutationInvariants.js";
import {
  DEFAULT_REPORT_CONFIG_PATH,
  cloneDefaultReportConfig,
  defaultReportConfig,
  loadReportConfig,
  mergeCodeInsightConfig
} from "./report/reportConfig.js";
import { contextForIssue, contextForVerb, formatIssueContext, formatVerbContext } from "./context/contextBundles.js";
import { buildIssueWebReport, formatIssueWebReportHtml, serveIssueWebReport } from "./web/issueReportServer.js";
import {
  explainReceiver,
  formatCallerQuery,
  formatReceiverExplanation,
  formatRefQuery,
  formatSourceVerbQuery,
  queryCallers,
  queryRefs,
  querySourceVerb
} from "./query/queryResolvedGraph.js";
import type {
  ReportUnresolvedOptions,
  UnresolvedPropertyAccessGroup,
  UnresolvedReport,
  UnresolvedVerbCallGroup,
  UnresolvedReasonGroup
} from "./report/reportUnresolved.js";
import type { CoverageReasonGroup, CoverageReport, ReportCoverageOptions } from "./report/reportCoverage.js";
import type { IssueBucket, IssueBucketSummary, IssueDomain, IssueFinding, IssuesReport, ReportIssuesOptions } from "./report/reportIssues.js";
import type {
  ExternalEntrypointBucket,
  ExternalEntrypointFinding,
  ExternalEntrypointSummary,
  ReportUnusedVerbsOptions,
  UnusedVerbBucket,
  UnusedVerbBucketSummary,
  UnusedVerbEntrypointKind,
  UnusedVerbFinding,
  UnusedVerbsReport
} from "./report/reportUnusedVerbs.js";
import type {
  ReportUnprogrammedVerbsOptions,
  UnprogrammedVerbBucket,
  UnprogrammedVerbBucketSummary,
  UnprogrammedVerbFinding,
  UnprogrammedVerbsReport
} from "./report/reportUnprogrammedVerbs.js";
import type {
  CodeInsightBucket,
  CodeInsightBucketSummary,
  CodeInsightFinding,
  CodeInsightsReport,
  ReportCodeInsightsOptions
} from "./report/reportCodeInsights.js";
import type {
  MutationInvariantBucket,
  MutationInvariantBucketSummary,
  MutationInvariantFinding,
  MutationInvariantsReport,
  ReportMutationInvariantsOptions,
  ValueShape
} from "./report/reportMutationInvariants.js";
import type { CodeInsightReportConfig, DeadCodeReportConfig, LoadedReportConfig, MutationInvariantReportConfig, ReportConfig } from "./report/reportConfig.js";
import type {
  ContextIssueOptions,
  ContextVerbOptions,
  IssueContextBundle,
  SourceSnippet,
  VerbContextBundle
} from "./context/contextBundles.js";
import type {
  BuildIssueWebReportOptions,
  IssueWebReport,
  IssueWebReportBucket,
  IssueWebReportIssue,
  IssueWebReportReasonGroup,
  IssueWebReportSnippet,
  ServedIssueWebReport,
  ServeIssueWebReportOptions
} from "./web/issueReportServer.js";
import type {
  CallerQueryResult,
  ExplainReceiverOptions,
  QueryCallersOptions,
  QueryRefsOptions,
  QuerySourceVerbOptions,
  ReceiverExplanation,
  RefQueryResult,
  SourceVerbQueryResult
} from "./query/queryResolvedGraph.js";
import type {
  FlowConfidence,
  FlowProvenance,
  FlowUnresolvedReason,
  FlowValueKind,
  InferredReceiverCandidateFact,
  LocalVariableStateFact
} from "./flow/types.js";

export type {
  CoreCandidateRecord,
  ExtractManifest,
  ExtractedObjectRecord,
  ExtractedPropertyDefinitionRecord,
  ExtractedPropertyValueRecord,
  ExtractedVerbRecord,
  ObjectRef
};
export { inspectExtractDir, validateExtractDir };
export { resolveMooCodeGraph };
export { formatUnresolvedReport, reportUnresolved };
export { formatCoverageReport, reportCoverage };
export { formatIssuesReport, reportIssues };
export { formatUnprogrammedVerbsReport, reportUnprogrammedVerbs };
export { formatUnusedVerbsReport, reportUnusedVerbs };
export { formatCodeInsightsReport, reportCodeInsights };
export { formatMutationInvariantsReport, reportMutationInvariants };
export { DEFAULT_REPORT_CONFIG_PATH, cloneDefaultReportConfig, defaultReportConfig, loadReportConfig, mergeCodeInsightConfig };
export { contextForIssue, contextForVerb, formatIssueContext, formatVerbContext };
export { buildIssueWebReport, formatIssueWebReportHtml, serveIssueWebReport };
export {
  explainReceiver,
  formatCallerQuery,
  formatReceiverExplanation,
  formatRefQuery,
  formatSourceVerbQuery,
  queryCallers,
  queryRefs,
  querySourceVerb
};
export type {
  InspectResult,
  ValidationResult,
  ResolveMooCodeGraphOptions,
  ResolveProgressEvent,
  ResolveResult,
  ResolveStats,
  ReportUnresolvedOptions,
  UnresolvedPropertyAccessGroup,
  UnresolvedReport,
  UnresolvedVerbCallGroup,
  UnresolvedReasonGroup,
  CoverageReasonGroup,
  CoverageReport,
  ReportCoverageOptions,
  IssueBucket,
  IssueBucketSummary,
  IssueDomain,
  IssueFinding,
  IssuesReport,
  ReportIssuesOptions,
  ExternalEntrypointBucket,
  ExternalEntrypointFinding,
  ExternalEntrypointSummary,
  ReportUnusedVerbsOptions,
  UnusedVerbBucket,
  UnusedVerbBucketSummary,
  UnusedVerbEntrypointKind,
  UnusedVerbFinding,
  UnusedVerbsReport,
  ReportUnprogrammedVerbsOptions,
  UnprogrammedVerbBucket,
  UnprogrammedVerbBucketSummary,
  UnprogrammedVerbFinding,
  UnprogrammedVerbsReport,
  CodeInsightBucket,
  CodeInsightBucketSummary,
  CodeInsightFinding,
  CodeInsightsReport,
  ReportCodeInsightsOptions,
  MutationInvariantBucket,
  MutationInvariantBucketSummary,
  MutationInvariantFinding,
  MutationInvariantsReport,
  ReportMutationInvariantsOptions,
  ValueShape,
  CodeInsightReportConfig,
  DeadCodeReportConfig,
  MutationInvariantReportConfig,
  LoadedReportConfig,
  ReportConfig,
  ContextIssueOptions,
  ContextVerbOptions,
  IssueContextBundle,
  SourceSnippet,
  VerbContextBundle,
  BuildIssueWebReportOptions,
  IssueWebReport,
  IssueWebReportBucket,
  IssueWebReportIssue,
  IssueWebReportReasonGroup,
  IssueWebReportSnippet,
  ServedIssueWebReport,
  ServeIssueWebReportOptions,
  CallerQueryResult,
  ExplainReceiverOptions,
  QueryCallersOptions,
  QueryRefsOptions,
  QuerySourceVerbOptions,
  ReceiverExplanation,
  RefQueryResult,
  SourceVerbQueryResult,
  FlowConfidence,
  FlowProvenance,
  FlowUnresolvedReason,
  FlowValueKind,
  InferredReceiverCandidateFact,
  LocalVariableStateFact
};

export interface IndexMooCodeGraphOptions {
  extractDir: string;
  outputDir: string;
  overwrite?: boolean;
  pretty?: boolean;
  quiet?: boolean;
  onProgress?: (event: IndexProgressEvent) => void;
}

export interface IndexProgressEvent {
  phase: "load_manifest" | "load_verbs" | "parse_code" | "emit_facts" | "write_manifest" | "done";
  message?: string;
  current?: number;
  total?: number;
}

export interface IndexStats {
  verbCount: number;
  verbCodeFileCount: number;
  parsedFileCount: number;
  parseErrorCount: number;
  callsiteCount: number;
  functionCallCount: number;
  objectRefCount: number;
  systemObjectRefCount: number;
  propertyAccessCount: number;
  assignmentCount: number;
  localBindingCount: number;
  destructuringBindingCount: number;
  loopBindingCount: number;
  branchGuardCount: number;
  verbMetricCount: number;
  identifierRefCount: number;
  stringLiteralCount: number;
  commentCount: number;
}

export interface IndexResult {
  extractDir: string;
  outputDir: string;
  stats: IndexStats;
}

export async function indexMooCodeGraph(options: IndexMooCodeGraphOptions): Promise<IndexResult> {
  options.onProgress?.({ phase: "load_manifest", message: "Loading extractor manifest" });
  const validation = await validateExtractDir(options.extractDir);
  const fatalValidationErrors = validation.errors.filter((error) => !isSourceFileReadError(options.extractDir, error.path));
  if (fatalValidationErrors.length > 0) {
    throw new CodeGraphError("Invalid extractor output directory", { errors: fatalValidationErrors });
  }

  const startedAt = new Date().toISOString();
  const manifest = await loadExtractManifest(options.extractDir);
  options.onProgress?.({ phase: "load_verbs", message: "Loading verb metadata" });
  const verbs = await loadVerbs(options.extractDir);
  const programmed = verbs.filter((verb) => verb.hasProgram && verb.sourcePath);
  const stats = createEmptyStats();
  stats.verbCount = verbs.length;
  stats.verbCodeFileCount = programmed.length;

  if (options.overwrite) await rm(options.outputDir, { recursive: true, force: true });
  await mkdir(join(options.outputDir, "code_facts"), { recursive: true });
  const writers = createWriters(options.outputDir, options.pretty ?? false);

  try {
    const parser = new MooParser();
    for (let index = 0; index < programmed.length; index += 1) {
      const verb = programmed[index]!;
      options.onProgress?.({ phase: "parse_code", message: verb.sourcePath, current: index + 1, total: programmed.length });
      const sourcePath = verb.sourcePath!;
      const meta = { sourceVerbId: verb.id, sourceObject: verb.object, sourcePath };
      try {
        const parsed = await parseVerbCode(join(options.extractDir, sourcePath), parser);
        stats.parsedFileCount += 1;
        const facts = extractFactsFromTree(parsed.tree, parsed.source, meta);
        addFactsToStats(stats, facts);
        await writeFacts(writers, facts);
      } catch (cause) {
        const fact: ParseErrorFact = {
          kind: "parse_error",
          ...meta,
          line: 0,
          column: 0,
          message: cause instanceof Error ? cause.message : String(cause),
          errorText: "",
          sourceLine: ""
        };
        stats.parseErrorCount += 1;
        await writers.parseErrors.write(fact);
      }
    }

    options.onProgress?.({ phase: "emit_facts", message: "Writing stats" });
    await writeFile(join(options.outputDir, "code_facts", "stats.json"), `${JSON.stringify(stats, null, 2)}\n`, "utf8");
    options.onProgress?.({ phase: "write_manifest", message: "Writing manifest" });
    await writeManifest({
      outputDir: options.outputDir,
      sourceExtractDir: options.extractDir,
      sourceManifest: manifest,
      startedAt,
      completedAt: new Date().toISOString(),
      pretty: options.pretty
    });
  } finally {
    await closeWriters(writers);
  }

  options.onProgress?.({ phase: "done", message: "Index complete" });
  return { extractDir: options.extractDir, outputDir: options.outputDir, stats };
}

function createWriters(outputDir: string, pretty: boolean) {
  const factsDir = join(outputDir, "code_facts");
  return {
    callsites: new JsonlWriter(join(factsDir, "callsites.jsonl"), pretty),
    functionCalls: new JsonlWriter(join(factsDir, "function_calls.jsonl"), pretty),
    objectRefs: new JsonlWriter(join(factsDir, "object_refs.jsonl"), pretty),
    systemObjectRefs: new JsonlWriter(join(factsDir, "system_object_refs.jsonl"), pretty),
    propertyAccesses: new JsonlWriter(join(factsDir, "property_accesses.jsonl"), pretty),
    assignments: new JsonlWriter(join(factsDir, "assignments.jsonl"), pretty),
    localBindings: new JsonlWriter(join(factsDir, "local_bindings.jsonl"), pretty),
    destructuringBindings: new JsonlWriter(join(factsDir, "destructuring_bindings.jsonl"), pretty),
    loopBindings: new JsonlWriter(join(factsDir, "loop_bindings.jsonl"), pretty),
    branchGuards: new JsonlWriter(join(factsDir, "branch_guards.jsonl"), pretty),
    verbMetrics: new JsonlWriter(join(factsDir, "verb_metrics.jsonl"), pretty),
    identifierRefs: new JsonlWriter(join(factsDir, "identifier_refs.jsonl"), pretty),
    stringLiterals: new JsonlWriter(join(factsDir, "string_literals.jsonl"), pretty),
    comments: new JsonlWriter(join(factsDir, "comments.jsonl"), pretty),
    parseErrors: new JsonlWriter(join(factsDir, "parse_errors.jsonl"), pretty)
  };
}

async function writeFacts(writers: ReturnType<typeof createWriters>, facts: ExtractedFacts): Promise<void> {
  for (const fact of facts.verbMetrics) await writers.verbMetrics.write(fact);
  for (const fact of facts.identifierRefs) await writers.identifierRefs.write(fact);
  for (const fact of facts.stringLiterals) await writers.stringLiterals.write(fact);
  for (const fact of facts.callsites) await writers.callsites.write(fact);
  for (const fact of facts.functionCalls) await writers.functionCalls.write(fact);
  for (const fact of facts.objectRefs) await writers.objectRefs.write(fact);
  for (const fact of facts.systemObjectRefs) await writers.systemObjectRefs.write(fact);
  for (const fact of facts.propertyAccesses) await writers.propertyAccesses.write(fact);
  for (const fact of facts.assignments) await writers.assignments.write(fact);
  for (const fact of facts.localBindings) await writers.localBindings.write(fact);
  for (const fact of facts.destructuringBindings) await writers.destructuringBindings.write(fact);
  for (const fact of facts.loopBindings) await writers.loopBindings.write(fact);
  for (const fact of facts.branchGuards) await writers.branchGuards.write(fact);
  for (const fact of facts.comments) await writers.comments.write(fact);
  for (const fact of facts.parseErrors) await writers.parseErrors.write(fact);
}

async function closeWriters(writers: ReturnType<typeof createWriters>): Promise<void> {
  await Promise.all(Object.values(writers).map((writer) => writer.close()));
}

function isSourceFileReadError(extractDir: string, path: string | undefined): boolean {
  return path !== undefined && path.startsWith(join(extractDir, "verb_code"));
}
