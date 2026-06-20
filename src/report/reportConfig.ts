import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

export const DEFAULT_REPORT_CONFIG_PATH = "moo-code-graph.yaml";

export interface CodeInsightReportConfig {
  minComplexity: number;
  minLines: number;
  minNesting: number;
  minPropertyWrites: number;
  minDynamicAccesses: number;
  minFanOut: number;
  minInlineErrorCount: number;
  minRepeatedStringCount: number;
  minRepeatedStringLength: number;
  minNormalizedDuplicateLines: number;
  includeUnusedDestructuringArgsWhenOtherArgsAreUsed: boolean;
}

export interface DeadCodeReportConfig {
  unusedVerbs: {
    programmaticOnly: boolean;
    requireExecute: boolean;
  };
}

export interface MutationInvariantReportConfig {
  enabled: boolean;
  ignoreProperties: string[];
  ignoreSourceVerbs: string[];
  ignoreBuckets: string[];
}

export interface ReportConfig {
  reports: {
    codeInsights: CodeInsightReportConfig;
    deadCode: DeadCodeReportConfig;
    mutationInvariants: MutationInvariantReportConfig;
  };
}

export interface LoadedReportConfig {
  config: ReportConfig;
  path?: string;
  hash?: string;
}

export const defaultReportConfig: ReportConfig = {
  reports: {
    codeInsights: {
      minComplexity: 15,
      minLines: 120,
      minNesting: 4,
      minPropertyWrites: 10,
      minDynamicAccesses: 5,
      minFanOut: 25,
      minInlineErrorCount: 8,
      minRepeatedStringCount: 3,
      minRepeatedStringLength: 8,
      minNormalizedDuplicateLines: 5,
      includeUnusedDestructuringArgsWhenOtherArgsAreUsed: false
    },
    deadCode: {
      unusedVerbs: {
        programmaticOnly: true,
        requireExecute: false
      }
    },
    mutationInvariants: {
      enabled: true,
      ignoreProperties: [],
      ignoreSourceVerbs: [],
      ignoreBuckets: []
    }
  }
};

export async function loadReportConfig(path = DEFAULT_REPORT_CONFIG_PATH): Promise<LoadedReportConfig> {
  const resolvedPath = resolve(path);
  try {
    await access(resolvedPath);
  } catch {
    return { config: cloneDefaultReportConfig() };
  }

  const content = await readFile(resolvedPath, "utf8");
  const parsed = YAML.parse(content) as unknown;
  return {
    config: parseReportConfig(parsed),
    path: resolvedPath,
    hash: createHash("sha256").update(content).digest("hex")
  };
}

export function mergeCodeInsightConfig(
  config: CodeInsightReportConfig,
  overrides: Partial<Pick<CodeInsightReportConfig, "minComplexity" | "minLines" | "minNesting">>
): CodeInsightReportConfig {
  return {
    ...config,
    ...(overrides.minComplexity !== undefined ? { minComplexity: overrides.minComplexity } : {}),
    ...(overrides.minLines !== undefined ? { minLines: overrides.minLines } : {}),
    ...(overrides.minNesting !== undefined ? { minNesting: overrides.minNesting } : {})
  };
}

export function cloneDefaultReportConfig(): ReportConfig {
  return JSON.parse(JSON.stringify(defaultReportConfig)) as ReportConfig;
}

function parseReportConfig(value: unknown): ReportConfig {
  const config = cloneDefaultReportConfig();
  if (value === null || value === undefined) return config;
  const root = objectValue(value, "config");
  assertKnownKeys(root, "config", ["reports"]);
  if (!("reports" in root)) return config;

  const reports = objectValue(root.reports, "reports");
  assertKnownKeys(reports, "reports", ["codeInsights", "deadCode", "mutationInvariants"]);
  if ("codeInsights" in reports) parseCodeInsightsConfig(reports.codeInsights, config.reports.codeInsights);
  if ("deadCode" in reports) parseDeadCodeConfig(reports.deadCode, config.reports.deadCode);
  if ("mutationInvariants" in reports) parseMutationInvariantsConfig(reports.mutationInvariants, config.reports.mutationInvariants);
  return config;
}

function parseCodeInsightsConfig(value: unknown, target: CodeInsightReportConfig): void {
  const input = objectValue(value, "reports.codeInsights");
  const keys = [
    "minComplexity",
    "minLines",
    "minNesting",
    "minPropertyWrites",
    "minDynamicAccesses",
    "minFanOut",
    "minInlineErrorCount",
    "minRepeatedStringCount",
    "minRepeatedStringLength",
    "minNormalizedDuplicateLines",
    "includeUnusedDestructuringArgsWhenOtherArgsAreUsed"
  ] as const;
  const deprecatedKeys = ["deepBranchHotspotDepth"];
  assertKnownKeys(input, "reports.codeInsights", [...keys, ...deprecatedKeys]);
  for (const key of keys) {
    if (!(key in input)) continue;
    if (key === "includeUnusedDestructuringArgsWhenOtherArgsAreUsed") {
      target[key] = booleanValue(input[key], `reports.codeInsights.${key}`);
    } else {
      target[key] = positiveInteger(input[key], `reports.codeInsights.${key}`);
    }
  }
}

function parseDeadCodeConfig(value: unknown, target: DeadCodeReportConfig): void {
  const input = objectValue(value, "reports.deadCode");
  assertKnownKeys(input, "reports.deadCode", ["unusedVerbs"]);
  if (!("unusedVerbs" in input)) return;

  const unusedVerbs = objectValue(input.unusedVerbs, "reports.deadCode.unusedVerbs");
  assertKnownKeys(unusedVerbs, "reports.deadCode.unusedVerbs", ["programmaticOnly", "requireExecute"]);
  if ("programmaticOnly" in unusedVerbs) target.unusedVerbs.programmaticOnly = booleanValue(unusedVerbs.programmaticOnly, "reports.deadCode.unusedVerbs.programmaticOnly");
  if ("requireExecute" in unusedVerbs) target.unusedVerbs.requireExecute = booleanValue(unusedVerbs.requireExecute, "reports.deadCode.unusedVerbs.requireExecute");
}

function parseMutationInvariantsConfig(value: unknown, target: MutationInvariantReportConfig): void {
  const input = objectValue(value, "reports.mutationInvariants");
  assertKnownKeys(input, "reports.mutationInvariants", ["enabled", "ignoreProperties", "ignoreSourceVerbs", "ignoreBuckets"]);
  if ("enabled" in input) target.enabled = booleanValue(input.enabled, "reports.mutationInvariants.enabled");
  if ("ignoreProperties" in input) target.ignoreProperties = stringArray(input.ignoreProperties, "reports.mutationInvariants.ignoreProperties");
  if ("ignoreSourceVerbs" in input) target.ignoreSourceVerbs = stringArray(input.ignoreSourceVerbs, "reports.mutationInvariants.ignoreSourceVerbs");
  if ("ignoreBuckets" in input) target.ignoreBuckets = stringArray(input.ignoreBuckets, "reports.mutationInvariants.ignoreBuckets");
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(`${path} must be an object`);
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new Error(`${path} must be a positive integer`);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${path} must be a boolean`);
}

function stringArray(value: unknown, path: string): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [...value];
  throw new Error(`${path} must be an array of strings`);
}

function assertKnownKeys(value: Record<string, unknown>, path: string, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`Unknown report config key ${path}.${key}`);
  }
}
