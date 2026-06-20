import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { extractToastStuntDb } from "@sindomecorp/toaststunt-db-extractor";
import { indexMooCodeGraph, resolveMooCodeGraph, validateExtractDir } from "../index.js";
import { readJsonl } from "../load/JsonlReader.js";
import type { ParseErrorFact } from "../facts/types.js";
import { buildIssueWebReport, describeIssue, type IssueWebReport, type IssueWebReportDomainKey, type IssueWebReportIssue } from "./issueReportServer.js";
import { loadReportConfig, type ReportConfig } from "../report/reportConfig.js";

export type ReportWorkspaceKey = "code_bugs" | "handled_expected" | "dead_code" | "graph_refinement" | "code_insights" | "mutation_invariants";

export interface RunReportOptions {
  dbPath: string;
  dbName?: string;
  reportsDir?: string;
  configPath?: string;
  overwrite?: boolean;
  pretty?: boolean;
  quiet?: boolean;
  timestamp?: string;
  onProgress?: (event: { phase: string; message?: string }) => void;
}

export interface RunReportResult {
  reportsDir: string;
  dbName: string;
  runId: string;
  runDir: string;
  extractDir: string;
  graphDir: string;
  resolvedDir: string;
  reportDir: string;
  manifest: StoredReportManifest;
}

export interface RerunLatestExtractReportOptions {
  reportsDir?: string;
  dbName: string;
  configPath?: string;
  overwrite?: boolean;
  pretty?: boolean;
  quiet?: boolean;
  timestamp?: string;
  onProgress?: (event: { phase: string; message?: string }) => void;
}

export interface StoredReportManifest {
  dbName: string;
  runId: string;
  dbPath?: string;
  generatedAt: string;
  extractDir: string;
  graphDir: string;
  resolvedDir: string;
  reportDir: string;
  runDir?: string;
  indexStats?: unknown;
  resolveStats?: unknown;
  parseErrorCount: number;
  reportConfig?: ReportConfig;
  reportConfigPath?: string;
  reportConfigHash?: string;
}

export interface ReportsCatalog {
  generatedAt: string;
  latest?: { dbName: string; runId: string };
  databases: ReportsCatalogDatabase[];
}

export interface ReportsCatalogDatabase {
  dbName: string;
  latestRunId?: string;
  runs: ReportsCatalogRun[];
}

export interface ReportsCatalogRun {
  runId: string;
  generatedAt: string;
  path: string;
  parseErrorCount: number;
}

export interface StoredReportSummary {
  dbName: string;
  runId: string;
  generatedAt: string;
  total: number;
  parseErrorCount: number;
  parseErrors: StoredParseErrorSample[];
  workspaces: StoredReportWorkspaceSummary[];
}

export interface StoredReportWorkspaceSummary {
  workspace: ReportWorkspaceKey;
  label: string;
  count: number;
  buckets: Array<{ bucket: string; count: number; reasons: Array<{ reason: string; count: number }> }>;
}

export interface StoredReportItem {
  workspace: ReportWorkspaceKey;
  domain: IssueWebReportDomainKey;
  bucket: string;
  reason: string;
  ref: string;
  refKind: string;
  description: string;
  sourceVerbId: string;
  sourceVerbName?: string;
  sourceObject: string;
  sourcePath: string;
  line: number;
  column: number;
  issue: IssueWebReportIssue;
  searchText: string;
}

export interface ReportItemsQuery {
  workspace?: string;
  bucket?: string;
  reason?: string;
  q?: string;
  offset?: number;
  limit?: number;
}

export interface ReportItemsPage {
  total: number;
  offset: number;
  limit: number;
  items: StoredReportItem[];
  buckets: Array<{ bucket: string; count: number }>;
  reasons: Array<{ reason: string; count: number }>;
}

interface WorkspaceDefinition {
  workspace: ReportWorkspaceKey;
  label: string;
  domains: IssueWebReportDomainKey[];
}

const DEFAULT_REPORTS_DIR = "reports";
const REPORT_SCHEMA_VERSION = "dynamic-report/v1";
const WORKSPACES: WorkspaceDefinition[] = [
  { workspace: "code_bugs", label: "Code Bugs", domains: ["moo_bug"] },
  { workspace: "code_insights", label: "Code Improvements", domains: ["code_insights"] },
  { workspace: "mutation_invariants", label: "Mutation / Invariants", domains: ["mutation_invariants"] },
  { workspace: "dead_code", label: "Dead Code", domains: ["unused_verbs", "unprogrammed_verbs"] },
  { workspace: "handled_expected", label: "Handled / Expected", domains: ["handled_inline", "external_entrypoints"] },
  { workspace: "graph_refinement", label: "Dynamic Resolution", domains: ["graph_refinement"] }
];

export async function runReportPipeline(options: RunReportOptions): Promise<RunReportResult> {
  const reportsDir = resolve(options.reportsDir ?? DEFAULT_REPORTS_DIR);
  const dbPath = resolve(options.dbPath);
  const dbName = sanitizeDbName(options.dbName ?? (basename(dbPath).replace(/\.[^.]+$/, "") || "database"));
  const reportConfig = await loadReportConfig(options.configPath);
  const runId = options.timestamp ?? timestampId(new Date());
  const runDir = join(reportsDir, dbName, runId);
  const extractDir = join(runDir, "extract");
  const graphDir = join(runDir, "graph");
  const resolvedDir = join(runDir, "resolved");
  const reportDir = join(runDir, "report");

  if (options.overwrite) await rm(runDir, { recursive: true, force: true });
  await assertWritableRunDir(runDir);
  await mkdir(runDir, { recursive: true });

  options.onProgress?.({ phase: "extract", message: dbPath });
  await extractToastStuntDb({
    inputPath: dbPath,
    outputDir: extractDir,
    overwrite: true,
    includeVerbCode: true,
    quiet: true
  });

  const validation = await validateExtractDir(extractDir);
  if (!validation.valid) {
    throw new Error(`Extractor output failed validation: ${JSON.stringify(validation.errors)}`);
  }

  options.onProgress?.({ phase: "index", message: extractDir });
  const indexResult = await indexMooCodeGraph({
    extractDir,
    outputDir: graphDir,
    overwrite: true,
    pretty: options.pretty,
    quiet: options.quiet,
    onProgress: options.quiet ? undefined : (event) => options.onProgress?.({ phase: `index:${event.phase}`, message: event.message })
  });

  options.onProgress?.({ phase: "resolve", message: graphDir });
  const resolveResult = await resolveMooCodeGraph({
    extractDir,
    graphDir,
    outputDir: resolvedDir,
    overwrite: true,
    pretty: options.pretty,
    quiet: options.quiet,
    onProgress: options.quiet ? undefined : (event) => options.onProgress?.({ phase: `resolve:${event.phase}`, message: event.message })
  });

  options.onProgress?.({ phase: "materialize_report", message: reportDir });
  const materialized = await materializeReportRun({
    dbName,
    runId,
    runDir,
    reportDir,
    resolvedDir,
    config: reportConfig.config,
    pretty: options.pretty
  });

  const manifest: StoredReportManifest = {
    dbName,
    runId,
    dbPath,
    generatedAt: materialized.summary.generatedAt,
    extractDir,
    graphDir,
    resolvedDir,
    reportDir,
    runDir,
    indexStats: indexResult.stats,
    resolveStats: resolveResult.stats,
    parseErrorCount: materialized.summary.parseErrorCount,
    reportConfig: reportConfig.config,
    ...(reportConfig.path ? { reportConfigPath: reportConfig.path } : {}),
    ...(reportConfig.hash ? { reportConfigHash: reportConfig.hash } : {})
  };
  await writeJson(join(runDir, "manifest.json"), { schemaVersion: REPORT_SCHEMA_VERSION, ...manifest }, options.pretty);
  await updateCatalog(reportsDir, manifest, options.pretty);

  options.onProgress?.({ phase: "done", message: runDir });
  return { reportsDir, dbName, runId, runDir, extractDir, graphDir, resolvedDir, reportDir, manifest };
}

export async function rerunLatestExtractReport(options: RerunLatestExtractReportOptions): Promise<RunReportResult> {
  const reportsDir = resolve(options.reportsDir ?? DEFAULT_REPORTS_DIR);
  const dbName = sanitizeDbName(options.dbName);
  const reportConfig = await loadReportConfig(options.configPath);
  const catalog = await readReportsCatalog(reportsDir);
  const db = catalog.databases.find((candidate) => candidate.dbName === dbName);
  const sourceRunId = db?.latestRunId ?? (catalog.latest?.dbName === dbName ? catalog.latest.runId : undefined);
  if (!sourceRunId) throw new Error(`No latest report found for database ${dbName}`);

  const sourceRunDir = join(reportsDir, dbName, sourceRunId);
  const sourceManifest = JSON.parse(await readFile(join(sourceRunDir, "manifest.json"), "utf8")) as StoredReportManifest;
  const sourceExtractDir = resolve(sourceManifest.extractDir ?? join(sourceRunDir, "extract"));
  const runId = options.timestamp ?? timestampId(new Date());
  const runDir = join(reportsDir, dbName, runId);
  const extractDir = join(runDir, "extract");
  const graphDir = join(runDir, "graph");
  const resolvedDir = join(runDir, "resolved");
  const reportDir = join(runDir, "report");

  if (options.overwrite) await rm(runDir, { recursive: true, force: true });
  await assertWritableRunDir(runDir);
  await mkdir(runDir, { recursive: true });

  options.onProgress?.({ phase: "copy_extract", message: sourceExtractDir });
  await cp(sourceExtractDir, extractDir, { recursive: true });

  const validation = await validateExtractDir(extractDir);
  if (!validation.valid) {
    throw new Error(`Copied extractor output failed validation: ${JSON.stringify(validation.errors)}`);
  }

  options.onProgress?.({ phase: "index", message: extractDir });
  const indexResult = await indexMooCodeGraph({
    extractDir,
    outputDir: graphDir,
    overwrite: true,
    pretty: options.pretty,
    quiet: options.quiet,
    onProgress: options.quiet ? undefined : (event) => options.onProgress?.({ phase: `index:${event.phase}`, message: event.message })
  });

  options.onProgress?.({ phase: "resolve", message: graphDir });
  const resolveResult = await resolveMooCodeGraph({
    extractDir,
    graphDir,
    outputDir: resolvedDir,
    overwrite: true,
    pretty: options.pretty,
    quiet: options.quiet,
    onProgress: options.quiet ? undefined : (event) => options.onProgress?.({ phase: `resolve:${event.phase}`, message: event.message })
  });

  options.onProgress?.({ phase: "materialize_report", message: reportDir });
  const materialized = await materializeReportRun({
    dbName,
    runId,
    runDir,
    reportDir,
    resolvedDir,
    config: reportConfig.config,
    pretty: options.pretty
  });

  const manifest: StoredReportManifest = {
    dbName,
    runId,
    dbPath: sourceManifest.dbPath,
    generatedAt: materialized.summary.generatedAt,
    extractDir,
    graphDir,
    resolvedDir,
    reportDir,
    runDir,
    indexStats: indexResult.stats,
    resolveStats: resolveResult.stats,
    parseErrorCount: materialized.summary.parseErrorCount,
    reportConfig: reportConfig.config,
    ...(reportConfig.path ? { reportConfigPath: reportConfig.path } : {}),
    ...(reportConfig.hash ? { reportConfigHash: reportConfig.hash } : {})
  };
  await writeJson(join(runDir, "manifest.json"), { schemaVersion: REPORT_SCHEMA_VERSION, ...manifest }, options.pretty);
  await updateCatalog(reportsDir, manifest, options.pretty);

  options.onProgress?.({ phase: "done", message: runDir });
  return { reportsDir, dbName, runId, runDir, extractDir, graphDir, resolvedDir, reportDir, manifest };
}

export async function materializeReportRun(options: {
  dbName: string;
  runId: string;
  runDir: string;
  reportDir: string;
  resolvedDir: string;
  config?: ReportConfig;
  pretty?: boolean;
}): Promise<{ summary: StoredReportSummary; itemCount: number }> {
  await rm(options.reportDir, { recursive: true, force: true });
  await mkdir(options.reportDir, { recursive: true });

  const report = await buildIssueWebReport({
    resolvedDir: options.resolvedDir,
    examplesPerReason: Number.MAX_SAFE_INTEGER,
    maxIssues: Number.MAX_SAFE_INTEGER,
    config: options.config
  });
  const parseErrors = await readParseErrors(report);
  const items = flattenReportItems(report);
  const summary = summarizeStoredReport(options.dbName, options.runId, report.generatedAt, items, parseErrors);

  await writeJson(join(options.reportDir, "summary.json"), summary, options.pretty);
  await Promise.all(
    WORKSPACES.map(async (workspace) => {
      const rows = items.filter((item) => item.workspace === workspace.workspace);
      await writeJsonl(join(options.reportDir, `${workspace.workspace}.jsonl`), rows);
    })
  );
  await writeJson(
    join(options.reportDir, "manifest.json"),
    {
      schemaVersion: REPORT_SCHEMA_VERSION,
      dbName: options.dbName,
      runId: options.runId,
      generatedAt: summary.generatedAt,
      resolvedDir: options.resolvedDir,
      itemCount: items.length
    },
    options.pretty
  );
  return { summary, itemCount: items.length };
}

export async function readReportsCatalog(reportsDir: string): Promise<ReportsCatalog> {
  const path = join(resolve(reportsDir), "index.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as ReportsCatalog;
  } catch {
    return { generatedAt: new Date().toISOString(), databases: [] };
  }
}

export async function readReportSummary(reportsDir: string, dbName: string, runId: string): Promise<StoredReportSummary> {
  return JSON.parse(await readFile(join(resolve(reportsDir), dbName, runId, "report", "summary.json"), "utf8")) as StoredReportSummary;
}

export async function readReportItems(reportsDir: string, dbName: string, runId: string, query: ReportItemsQuery): Promise<ReportItemsPage> {
  const workspace = workspaceKey(query.workspace);
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.max(1, Math.min(query.limit ?? 50, 500));
  const q = query.q?.trim().toLowerCase();
  const path = join(resolve(reportsDir), dbName, runId, "report", `${workspace}.jsonl`);
  const all = await readJsonl<StoredReportItem>(path);
  const searched = all.filter((item) => (!q || item.searchText.includes(q)) && (!query.bucket || item.bucket === query.bucket) && (!query.reason || item.reason === query.reason));
  const bucketCounts = countBy(searched, (item) => item.bucket).map(([bucket, count]) => ({ bucket, count }));
  const reasonRows = all.filter((item) => (!q || item.searchText.includes(q)) && (!query.bucket || item.bucket === query.bucket));
  const reasonCounts = countBy(reasonRows, (item) => item.reason).map(([reason, count]) => ({ reason, count }));
  return {
    total: searched.length,
    offset,
    limit,
    items: searched.slice(offset, offset + limit),
    buckets: bucketCounts,
    reasons: reasonCounts
  };
}

function flattenReportItems(report: IssueWebReport): StoredReportItem[] {
  const items: StoredReportItem[] = [];
  for (const domain of report.domains) {
    const workspace = workspaceForDomain(domain.domain);
    for (const bucket of domain.buckets) {
      for (const reason of bucket.reasons) {
        for (const issue of reason.issues) {
          const description = issue.description ?? describeIssue(issue);
          const searchText = buildSearchText(workspace, domain.domain, bucket.bucket, reason.reason, issue, description);
          items.push({
            workspace,
            domain: domain.domain,
            bucket: bucket.bucket,
            reason: reason.reason,
            ref: issue.ref,
            refKind: issue.refKind,
            description,
            sourceVerbId: issue.sourceVerbId,
            ...(issue.sourceVerbName ? { sourceVerbName: issue.sourceVerbName } : {}),
            sourceObject: issue.sourceObject,
            sourcePath: issue.sourcePath,
            line: issue.line,
            column: issue.column,
            issue: { ...issue, description },
            searchText
          });
        }
      }
    }
  }
  return items.sort((left, right) => left.workspace.localeCompare(right.workspace) || left.bucket.localeCompare(right.bucket) || left.reason.localeCompare(right.reason) || left.sourcePath.localeCompare(right.sourcePath) || left.line - right.line || left.column - right.column);
}

function summarizeStoredReport(
  dbName: string,
  runId: string,
  generatedAt: string,
  items: StoredReportItem[],
  parseErrors: StoredParseErrors
): StoredReportSummary {
  return {
    dbName,
    runId,
    generatedAt,
    total: items.length,
    parseErrorCount: parseErrors.count,
    parseErrors: parseErrors.samples,
    workspaces: WORKSPACES.map((workspace) => {
      const rows = items.filter((item) => item.workspace === workspace.workspace);
      return {
        workspace: workspace.workspace,
        label: workspace.label,
        count: rows.length,
        buckets: countBy(rows, (item) => item.bucket).map(([bucket, count]) => ({
          bucket,
          count,
          reasons: countBy(rows.filter((item) => item.bucket === bucket), (item) => item.reason).map(([reason, reasonCount]) => ({ reason, count: reasonCount }))
        }))
      };
    })
  };
}

export interface StoredParseErrorSample {
  sourceVerbId: string;
  sourcePath: string;
  line: number;
  column: number;
  message: string;
  sourceLine?: string;
}

interface StoredParseErrors {
  count: number;
  samples: StoredParseErrorSample[];
}

async function readParseErrors(report: IssueWebReport): Promise<StoredParseErrors> {
  if (!report.sourceExtractDir) return { count: 0, samples: [] };
  const manifest = JSON.parse(await readFile(join(report.resolvedDir, "manifest.json"), "utf8")) as { sourceGraphDir?: string };
  const graphDir = manifest.sourceGraphDir ? resolve(manifest.sourceGraphDir) : join(report.resolvedDir, "..", "graph");
  const path = join(graphDir, "code_facts", "parse_errors.jsonl");
  try {
    const rows = await readJsonl<ParseErrorFact>(path);
    return {
      count: rows.length,
      samples: rows.slice(0, 50).map((row) => ({
        sourceVerbId: row.sourceVerbId,
        sourcePath: row.sourcePath,
        line: row.line,
        column: row.column,
        message: row.message,
        ...(row.sourceLine ? { sourceLine: row.sourceLine } : {})
      }))
    };
  } catch {
    return { count: 0, samples: [] };
  }
}

async function updateCatalog(reportsDir: string, manifest: StoredReportManifest, pretty?: boolean): Promise<void> {
  const catalog = await readReportsCatalog(reportsDir);
  const db = catalog.databases.find((candidate) => candidate.dbName === manifest.dbName) ?? { dbName: manifest.dbName, runs: [] };
  db.latestRunId = manifest.runId;
  db.runs = [
    {
      runId: manifest.runId,
      generatedAt: manifest.generatedAt,
      path: manifest.runDir ?? join(resolve(reportsDir), manifest.dbName, manifest.runId),
      parseErrorCount: manifest.parseErrorCount
    },
    ...db.runs.filter((run) => run.runId !== manifest.runId)
  ].sort((left, right) => right.runId.localeCompare(left.runId));
  const databases = [db, ...catalog.databases.filter((candidate) => candidate.dbName !== manifest.dbName)].sort((left, right) => left.dbName.localeCompare(right.dbName));
  const next: ReportsCatalog = {
    generatedAt: new Date().toISOString(),
    latest: { dbName: manifest.dbName, runId: manifest.runId },
    databases
  };
  await writeJson(join(resolve(reportsDir), "index.json"), next, pretty);
  await writeJson(join(resolve(reportsDir), manifest.dbName, "latest.json"), { dbName: manifest.dbName, runId: manifest.runId, generatedAt: manifest.generatedAt }, pretty);
}

function buildSearchText(
  workspace: string,
  domain: string,
  bucket: string,
  reason: string,
  issue: IssueWebReportIssue,
  description: string
): string {
  return [
    workspace,
    domain,
    bucket,
    reason,
    issue.ref,
    issue.refKind,
    issue.sourceVerbId,
    issue.sourceVerbName ?? "",
    issue.sourceObject,
    issue.sourcePath,
    issue.sourceLine ?? "",
    description,
    issue.guardText ?? "",
    issue.guardScope ?? "",
    issue.inlineErrorFallbackText ?? "",
    issue.inlineErrorExpressionText ?? "",
    issue.refKind === "verb_metric" ? `${issue.cyclomaticComplexity} ${issue.nonBlankLineCount} ${issue.maxControlFlowDepth} ${issue.statementCount}` : "",
    issue.refKind === "property_write" ? `${issue.property ?? ""} ${issue.receiverObject ?? ""} ${issue.dbShape ?? ""} ${issue.rhsShape ?? ""} ${issue.rightText ?? ""} ${issue.effectiveValuePreview ?? ""}` : "",
    ...(issue.inlineErrorCodes ?? []),
    ...(issue.sourceSnippet?.lines.map((line) => line.text) ?? [])
  ]
    .join(" ")
    .toLowerCase();
}

function workspaceForDomain(domain: IssueWebReportDomainKey): ReportWorkspaceKey {
  for (const workspace of WORKSPACES) {
    if (workspace.domains.includes(domain)) return workspace.workspace;
  }
  return "graph_refinement";
}

function workspaceKey(value: string | undefined): ReportWorkspaceKey {
  if (value && WORKSPACES.some((workspace) => workspace.workspace === value)) return value as ReportWorkspaceKey;
  return "code_bugs";
}

function countBy<T>(rows: T[], keyOf: (row: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

async function assertWritableRunDir(runDir: string): Promise<void> {
  try {
    await access(runDir);
    throw new Error(`Report run already exists at ${runDir}; pass --overwrite to replace it`);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("already exists")) throw cause;
  }
}

async function writeJson(path: string, value: unknown, pretty?: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`, "utf8");
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

function sanitizeDbName(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "database";
}

function timestampId(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
