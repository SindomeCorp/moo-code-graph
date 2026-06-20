import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtractedVerbRecord } from "@sindomecorp/toaststunt-db-extractor";
import type {
  AssignmentFact,
  CallsiteFact,
  DestructuringBindingFact,
  FunctionCallFact,
  IdentifierRefFact,
  LoopBindingFact,
  PropertyAccessFact,
  StringLiteralFact,
  SystemObjectRefFact,
  VerbMetricFact
} from "../facts/types.js";
import { readJsonl } from "../load/JsonlReader.js";
import { loadVerbs } from "../load/loadVerbs.js";
import { defaultReportConfig, mergeCodeInsightConfig, type CodeInsightReportConfig } from "./reportConfig.js";

export type CodeInsightBucket =
  | "high_complexity"
  | "large_verb"
  | "deep_nesting"
  | "unused_assignment"
  | "unused_loop_variable"
  | "unused_destructuring_binding"
  | "dead_store"
  | "write_only_variable"
  | "argument_heavy"
  | "mutation_heavy"
  | "dynamic_dispatch_hotspot"
  | "broad_coupling"
  | "error_handling_heavy"
  | "repeated_literal_string"
  | "similar_verb_body";

export interface ReportCodeInsightsOptions {
  resolvedDir: string;
  examplesPerBucket?: number;
  minComplexity?: number;
  minLines?: number;
  minNesting?: number;
  config?: CodeInsightReportConfig;
}

export interface CodeInsightFinding {
  bucket: CodeInsightBucket;
  reason: CodeInsightBucket;
  refKind: "verb_metric" | "identifier_binding" | "verb_aggregate" | "literal_string" | "similar_verb";
  ref: string;
  sourceVerbId: string;
  sourceVerbName?: string;
  sourceObject: string;
  sourcePath: string;
  line: number;
  column: number;
  cyclomaticComplexity?: number;
  lineCount?: number;
  nonBlankLineCount?: number;
  statementCount?: number;
  branchCount?: number;
  loopCount?: number;
  conditionalExpressionCount?: number;
  logicalOperatorCount?: number;
  tryCount?: number;
  inlineErrorCount?: number;
  maxControlFlowDepth?: number;
  variableName?: string;
  bindingKind?: "assignment" | "loop" | "destructuring";
  bindingText?: string;
  count?: number;
  distinctCount?: number;
  detail?: string;
  relatedSourceVerbId?: string;
  relatedSourceVerbName?: string;
  relatedSourceObject?: string;
  relatedSourcePath?: string;
  repeatedValue?: string;
}

export interface CodeInsightBucketSummary {
  bucket: CodeInsightBucket;
  count: number;
  examples: CodeInsightFinding[];
}

export interface CodeInsightsReport {
  resolvedDir: string;
  graphDir: string;
  sourceExtractDir?: string;
  examplesPerBucket: number;
  thresholds: {
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
  };
  totalMetricCount: number;
  total: number;
  buckets: CodeInsightBucketSummary[];
}

const codeInsightBuckets: CodeInsightBucket[] = [
  "high_complexity",
  "large_verb",
  "deep_nesting",
  "unused_assignment",
  "unused_loop_variable",
  "unused_destructuring_binding",
  "dead_store",
  "write_only_variable",
  "argument_heavy",
  "mutation_heavy",
  "dynamic_dispatch_hotspot",
  "broad_coupling",
  "error_handling_heavy",
  "repeated_literal_string",
  "similar_verb_body"
];

export async function reportCodeInsights(options: ReportCodeInsightsOptions): Promise<CodeInsightsReport> {
  const manifest = await readManifest(options.resolvedDir);
  const graphDir = graphDirFromManifest(options.resolvedDir, manifest);
  const sourceExtractDir = typeof manifest.sourceExtractDir === "string" ? resolve(manifest.sourceExtractDir) : undefined;
  const metricsPath = join(graphDir, "code_facts", "verb_metrics.jsonl");
  const metrics = existsSync(metricsPath) ? await readJsonl<VerbMetricFact>(metricsPath) : [];
  const assignments = await readFactFile<AssignmentFact>(graphDir, "assignments.jsonl");
  const destructuringBindings = await readFactFile<DestructuringBindingFact>(graphDir, "destructuring_bindings.jsonl");
  const loopBindings = await readFactFile<LoopBindingFact>(graphDir, "loop_bindings.jsonl");
  const identifierRefs = await readFactFile<IdentifierRefFact>(graphDir, "identifier_refs.jsonl");
  const callsites = await readFactFile<CallsiteFact>(graphDir, "callsites.jsonl");
  const functionCalls = await readFactFile<FunctionCallFact>(graphDir, "function_calls.jsonl");
  const propertyAccesses = await readFactFile<PropertyAccessFact>(graphDir, "property_accesses.jsonl");
  const systemObjectRefs = await readFactFile<SystemObjectRefFact>(graphDir, "system_object_refs.jsonl");
  const stringLiterals = await readFactFile<StringLiteralFact>(graphDir, "string_literals.jsonl");
  const verbs = sourceExtractDir ? await loadVerbsIfExists(sourceExtractDir) : [];
  const verbById = new Map(verbs.map((verb) => [verb.id, verb]));
  const examplesPerBucket = options.examplesPerBucket ?? 25;
  const thresholds = mergeCodeInsightConfig(options.config ?? defaultReportConfig.reports.codeInsights, {
    minComplexity: options.minComplexity,
    minLines: options.minLines,
    minNesting: options.minNesting
  });

  const findings: CodeInsightFinding[] = [];
  for (const metric of metrics) {
    const verb = verbById.get(metric.sourceVerbId);
    const buckets = findingBuckets(metric, thresholds);
    for (const bucket of buckets) findings.push(findingFromMetric(metric, bucket, verb));
  }
  findings.push(
    ...unusedVariableFindings(
      assignments,
      destructuringBindings,
      loopBindings,
      identifierRefs,
      verbById,
      thresholds.includeUnusedDestructuringArgsWhenOtherArgsAreUsed
    )
  );
  findings.push(...deadStoreFindings(assignments, identifierRefs, verbById));
  findings.push(...writeOnlyVariableFindings(assignments, identifierRefs, verbById));
  findings.push(...aggregateInsightFindings(metrics, identifierRefs, callsites, functionCalls, propertyAccesses, systemObjectRefs, verbById, thresholds));
  findings.push(...repeatedStringFindings(stringLiterals, verbById, thresholds));
  if (sourceExtractDir) findings.push(...(await similarVerbBodyFindings(verbs, sourceExtractDir, thresholds)));
  const sorted = findings.sort(compareFindings);

  return {
    resolvedDir: options.resolvedDir,
    graphDir,
    ...(sourceExtractDir ? { sourceExtractDir } : {}),
    examplesPerBucket,
    thresholds,
    totalMetricCount: metrics.length,
    total: sorted.length,
    buckets: summarizeBuckets(sorted, examplesPerBucket)
  };
}

export function formatCodeInsightsReport(report: CodeInsightsReport): string {
  const lines = [
    `Code insights: ${report.total}`,
    `  measured verbs: ${report.totalMetricCount}`,
    `  thresholds: complexity>=${report.thresholds.minComplexity}, lines>=${report.thresholds.minLines}, nesting>=${report.thresholds.minNesting}`
  ];
  for (const bucket of report.buckets) {
    if (bucket.count === 0) continue;
      lines.push("");
      lines.push(`${bucket.bucket}: ${bucket.count}`);
      for (const finding of bucket.examples) {
      if (finding.refKind === "verb_metric") {
        lines.push(
          `  ${finding.sourcePath}:${finding.line}:${finding.column} ${finding.ref} complexity=${finding.cyclomaticComplexity} lines=${finding.nonBlankLineCount} nesting=${finding.maxControlFlowDepth} statements=${finding.statementCount}`
        );
      } else if (finding.refKind === "identifier_binding") {
        lines.push(
          `  ${finding.sourcePath}:${finding.line}:${finding.column} ${finding.ref} variable=${finding.variableName} binding=${finding.bindingKind}`
        );
      } else {
        const count = finding.count !== undefined ? ` count=${finding.count}` : "";
        const distinct = finding.distinctCount !== undefined ? ` distinct=${finding.distinctCount}` : "";
        const detail = finding.detail ? ` ${finding.detail}` : "";
        lines.push(`  ${finding.sourcePath}:${finding.line}:${finding.column} ${finding.ref}${count}${distinct}${detail}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function findingBuckets(
  metric: VerbMetricFact,
  thresholds: { minComplexity: number; minLines: number; minNesting: number }
): CodeInsightBucket[] {
  const buckets: CodeInsightBucket[] = [];
  if (metric.cyclomaticComplexity >= thresholds.minComplexity) buckets.push("high_complexity");
  if (metric.nonBlankLineCount >= thresholds.minLines) buckets.push("large_verb");
  if (metric.maxControlFlowDepth >= thresholds.minNesting) buckets.push("deep_nesting");
  return buckets;
}

function findingFromMetric(metric: VerbMetricFact, bucket: CodeInsightBucket, verb: ExtractedVerbRecord | undefined): CodeInsightFinding {
  const name = verb?.primaryName;
  return {
    bucket,
    reason: bucket,
    refKind: "verb_metric",
    ref: `${metric.sourceVerbId} ${metric.sourceObject}:${name ?? metric.sourceVerbId}`,
    sourceVerbId: metric.sourceVerbId,
    ...(name ? { sourceVerbName: name } : {}),
    sourceObject: metric.sourceObject,
    sourcePath: metric.sourcePath,
    line: 0,
    column: 0,
    cyclomaticComplexity: metric.cyclomaticComplexity,
    lineCount: metric.lineCount,
    nonBlankLineCount: metric.nonBlankLineCount,
    statementCount: metric.statementCount,
    branchCount: metric.branchCount,
    loopCount: metric.loopCount,
    conditionalExpressionCount: metric.conditionalExpressionCount,
    logicalOperatorCount: metric.logicalOperatorCount,
    tryCount: metric.tryCount,
    inlineErrorCount: metric.inlineErrorCount,
    maxControlFlowDepth: metric.maxControlFlowDepth
  };
}

interface LocalBindingCandidate {
  sourceVerbId: string;
  sourceObject: string;
  sourcePath: string;
  line: number;
  column: number;
  variableName: string;
  bindingKind: "assignment" | "loop" | "destructuring";
  bindingText: string;
}

function unusedVariableFindings(
  assignments: AssignmentFact[],
  destructuringBindings: DestructuringBindingFact[],
  loopBindings: LoopBindingFact[],
  identifierRefs: IdentifierRefFact[],
  verbById: Map<string, ExtractedVerbRecord>,
  includeUnusedDestructuringArgsWhenOtherArgsAreUsed: boolean
): CodeInsightFinding[] {
  const readsByVerb = new Map<string, Set<string>>();
  for (const ref of identifierRefs) {
    const reads = readsByVerb.get(ref.sourceVerbId) ?? new Set<string>();
    reads.add(ref.name.toLowerCase());
    readsByVerb.set(ref.sourceVerbId, reads);
  }

  const bindings: LocalBindingCandidate[] = [
    ...assignments.flatMap((assignment) => {
      if (!isPlainIdentifier(assignment.leftText)) return [];
      return [
        {
          sourceVerbId: assignment.sourceVerbId,
          sourceObject: assignment.sourceObject,
          sourcePath: assignment.sourcePath,
          line: assignment.line,
          column: assignment.column,
          variableName: assignment.leftText,
          bindingKind: "assignment" as const,
          bindingText: assignment.leftText
        }
      ];
    }),
    ...loopBindings.map((binding) => ({
      sourceVerbId: binding.sourceVerbId,
      sourceObject: binding.sourceObject,
      sourcePath: binding.sourcePath,
      line: binding.line,
      column: binding.column,
      variableName: binding.variable,
      bindingKind: "loop" as const,
      bindingText: binding.collectionText
    }))
  ];

  const unusedBindings = bindings
    .filter((binding) => !isIgnoredVariable(binding.variableName))
    .filter((binding) => !isBindingRead(binding, readsByVerb));

  const destructuringCandidates = destructuringBindings.map((binding) => ({
    sourceVerbId: binding.sourceVerbId,
    sourceObject: binding.sourceObject,
    sourcePath: binding.sourcePath,
    line: binding.line,
    column: binding.column,
    variableName: binding.variable,
    bindingKind: "destructuring" as const,
    bindingText: binding.patternText,
    destructuringRightText: binding.rightText
  }));

  if (includeUnusedDestructuringArgsWhenOtherArgsAreUsed) {
    unusedBindings.push(
      ...destructuringCandidates.filter((binding) => !isIgnoredVariable(binding.variableName)).filter((binding) => !isBindingRead(binding, readsByVerb))
    );
  } else {
    for (const group of groupBy(destructuringCandidates, destructuringGroupKey).values()) {
      const hasAnyReadBinding = group.some((binding) => isBindingRead(binding, readsByVerb));
      if (hasAnyReadBinding) continue;
      unusedBindings.push(...group.filter((binding) => !isIgnoredVariable(binding.variableName)));
    }
  }

  return unusedBindings.map((binding) => unusedVariableFinding(binding, verbById.get(binding.sourceVerbId)));
}

function isBindingRead(binding: Pick<LocalBindingCandidate, "sourceVerbId" | "variableName">, readsByVerb: Map<string, Set<string>>): boolean {
  return (readsByVerb.get(binding.sourceVerbId) ?? new Set<string>()).has(binding.variableName.toLowerCase());
}

function destructuringGroupKey(binding: LocalBindingCandidate & { destructuringRightText: string }): string {
  return [
    binding.sourceVerbId,
    binding.sourceObject,
    binding.sourcePath,
    binding.line,
    binding.column,
    binding.bindingText,
    binding.destructuringRightText
  ].join("\t");
}

function unusedVariableFinding(binding: LocalBindingCandidate, verb: ExtractedVerbRecord | undefined): CodeInsightFinding {
  const name = verb?.primaryName;
  const bucket = unusedVariableBucket(binding.bindingKind);
  return {
    bucket,
    reason: bucket,
    refKind: "identifier_binding",
    ref: `${binding.sourceVerbId} ${binding.sourceObject}:${name ?? binding.sourceVerbId} ${binding.variableName}`,
    sourceVerbId: binding.sourceVerbId,
    ...(name ? { sourceVerbName: name } : {}),
    sourceObject: binding.sourceObject,
    sourcePath: binding.sourcePath,
    line: binding.line,
    column: binding.column,
    variableName: binding.variableName,
    bindingKind: binding.bindingKind,
    bindingText: binding.bindingText
  };
}

function unusedVariableBucket(bindingKind: LocalBindingCandidate["bindingKind"]): CodeInsightBucket {
  if (bindingKind === "loop") return "unused_loop_variable";
  if (bindingKind === "destructuring") return "unused_destructuring_binding";
  return "unused_assignment";
}

function isPlainIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isIgnoredVariable(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "_" || normalized.startsWith("_") || normalized === "ignored" || normalized.startsWith("ignored_");
}

function deadStoreFindings(
  assignments: AssignmentFact[],
  identifierRefs: IdentifierRefFact[],
  verbById: Map<string, ExtractedVerbRecord>
): CodeInsightFinding[] {
  const readsByVerbVariable = readsByVerbVariableIndex(identifierRefs);
  const assignmentGroups = groupBy(
    assignments.filter((assignment) => isPlainIdentifier(assignment.leftText) && !isIgnoredVariable(assignment.leftText)),
    (assignment) => `${assignment.sourceVerbId}\t${assignment.leftText.toLowerCase()}`
  );
  const findings: CodeInsightFinding[] = [];
  for (const rows of assignmentGroups.values()) {
    const sorted = [...rows].sort(comparePosition);
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const current = sorted[index]!;
      const next = sorted[index + 1]!;
      if (!canTreatAsDefiniteOverwrite(current, next)) continue;
      const reads = readsByVerbVariable.get(`${current.sourceVerbId}\t${current.leftText.toLowerCase()}`) ?? [];
      const readBeforeNext = reads.some((read) => readOccursBeforeOverwritingAssignment(current, next, read));
      if (!readBeforeNext) {
        findings.push(variableInsightFinding("dead_store", current, current.leftText, "assignment", current.rightText, verbById.get(current.sourceVerbId), {
          detail: `overwritten_at=${next.line}:${next.column}`
        }));
      }
    }
  }
  return findings;
}

function canTreatAsDefiniteOverwrite(current: AssignmentFact, next: AssignmentFact): boolean {
  if (current.assignmentKind === "expression") return false;
  return sameControlFlowPath(current, next);
}

function sameControlFlowPath(left: AssignmentFact, right: AssignmentFact): boolean {
  const leftPath = left.controlFlowPath ?? [];
  const rightPath = right.controlFlowPath ?? [];
  if (leftPath.length !== rightPath.length) return false;
  return leftPath.every((segment, index) => segment === rightPath[index]);
}

function readOccursBeforeOverwritingAssignment(current: AssignmentFact, next: AssignmentFact, read: IdentifierRefFact): boolean {
  if (comparePosition(current, read) >= 0) return false;
  if (comparePosition(read, next) < 0) return true;
  return readIsInsideAssignmentRightHandSide(next, read) && rightHandSideReferencesIdentifier(next, current.leftText);
}

function rightHandSideReferencesIdentifier(assignment: AssignmentFact, identifier: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(identifier)}([^A-Za-z0-9_]|$)`, "i").test(assignment.rightText);
}

function readIsInsideAssignmentRightHandSide(assignment: AssignmentFact, read: IdentifierRefFact): boolean {
  const rhsLineSpan = assignment.rightText.split(/\r?\n/).length - 1;
  return comparePosition(assignment, read) < 0 && read.line <= assignment.line + rhsLineSpan;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeOnlyVariableFindings(
  assignments: AssignmentFact[],
  identifierRefs: IdentifierRefFact[],
  verbById: Map<string, ExtractedVerbRecord>
): CodeInsightFinding[] {
  const readsByVerbVariable = readsByVerbVariableIndex(identifierRefs);
  const assignmentGroups = groupBy(
    assignments.filter((assignment) => isPlainIdentifier(assignment.leftText) && !isIgnoredVariable(assignment.leftText)),
    (assignment) => `${assignment.sourceVerbId}\t${assignment.leftText.toLowerCase()}`
  );
  const findings: CodeInsightFinding[] = [];
  for (const [key, rows] of assignmentGroups) {
    if (rows.length < 2 || (readsByVerbVariable.get(key) ?? []).length > 0) continue;
    const first = [...rows].sort(comparePosition)[0]!;
    findings.push(variableInsightFinding("write_only_variable", first, first.leftText, "assignment", first.rightText, verbById.get(first.sourceVerbId), {
      count: rows.length
    }));
  }
  return findings;
}

function aggregateInsightFindings(
  metrics: VerbMetricFact[],
  identifierRefs: IdentifierRefFact[],
  callsites: CallsiteFact[],
  functionCalls: FunctionCallFact[],
  propertyAccesses: PropertyAccessFact[],
  systemObjectRefs: SystemObjectRefFact[],
  verbById: Map<string, ExtractedVerbRecord>,
  thresholds: CodeInsightReportConfig
): CodeInsightFinding[] {
  const findings: CodeInsightFinding[] = [];
  const metricByVerb = new Map<string, VerbMetricFact>(metrics.map((metric) => [metric.sourceVerbId, metric]));
  const allVerbIds = new Set<string>([
    ...metrics.map((row) => row.sourceVerbId),
    ...identifierRefs.map((row) => row.sourceVerbId),
    ...callsites.map((row) => row.sourceVerbId),
    ...functionCalls.map((row) => row.sourceVerbId),
    ...propertyAccesses.map((row) => row.sourceVerbId),
    ...systemObjectRefs.map((row) => row.sourceVerbId)
  ]);

  for (const sourceVerbId of allVerbIds) {
    const metric = metricByVerb.get(sourceVerbId);
    const sample = metric ?? callsites.find((row) => row.sourceVerbId === sourceVerbId) ?? propertyAccesses.find((row) => row.sourceVerbId === sourceVerbId);
    if (!sample) continue;
    const verb = verbById.get(sourceVerbId);
    const refs = identifierRefs.filter((row) => row.sourceVerbId === sourceVerbId);
    const calls = callsites.filter((row) => row.sourceVerbId === sourceVerbId);
    const functions = functionCalls.filter((row) => row.sourceVerbId === sourceVerbId);
    const properties = propertyAccesses.filter((row) => row.sourceVerbId === sourceVerbId);
    const systems = systemObjectRefs.filter((row) => row.sourceVerbId === sourceVerbId);

    const argumentRefs = refs.filter((ref) => isArgumentHandlingIdentifier(ref.name) && !isMooBuiltinContextIdentifier(ref.name));
    if (argumentRefs.length >= 12) {
      findings.push(aggregateFinding("argument_heavy", sample, verb, { count: argumentRefs.length, detail: topNames(argumentRefs.map((ref) => ref.name)) }));
    }

    const writes = properties.filter((access) => access.accessKind === "write");
    if (writes.length >= thresholds.minPropertyWrites) {
      findings.push(
        aggregateFinding("mutation_heavy", sample, verb, {
          count: writes.length,
          distinctCount: new Set(writes.map((write) => `${write.receiverRaw}.${write.property ?? write.propertyExpression ?? ""}`)).size
        })
      );
    }

    const dynamicCalls = calls.filter((call) => call.selectorKind === "dynamic");
    const computedProperties = properties.filter((access) => access.propertyKind === "computed");
    const dynamicCount = dynamicCalls.length + computedProperties.length;
    if (dynamicCount >= thresholds.minDynamicAccesses) {
      findings.push(
        aggregateFinding("dynamic_dispatch_hotspot", sample, verb, {
          count: dynamicCount,
          detail: `dynamic_calls=${dynamicCalls.length} computed_properties=${computedProperties.length}`
        })
      );
    }

    const fanOut = new Set<string>();
    for (const call of calls) fanOut.add(`call:${call.receiverRaw}:${call.selector ?? call.selectorExpression ?? ""}`);
    for (const fn of functions) fanOut.add(`function:${fn.function}`);
    for (const access of properties) fanOut.add(`property:${access.receiverRaw}.${access.property ?? access.propertyExpression ?? ""}`);
    for (const system of systems) fanOut.add(`system:${system.symbol.toLowerCase()}`);
    if (fanOut.size >= thresholds.minFanOut) {
      findings.push(aggregateFinding("broad_coupling", sample, verb, { distinctCount: fanOut.size }));
    }

    const inlineHandledCount =
      calls.filter((call) => call.inlineErrorHandled).length +
      functions.filter((call) => call.inlineErrorHandled).length +
      properties.filter((access) => access.inlineErrorHandled).length;
    const errorHandlingCount = (metric?.tryCount ?? 0) + (metric?.inlineErrorCount ?? 0) + inlineHandledCount;
    if (errorHandlingCount >= thresholds.minInlineErrorCount) {
      findings.push(
        aggregateFinding("error_handling_heavy", sample, verb, {
          count: errorHandlingCount,
          detail: `try=${metric?.tryCount ?? 0} inline=${metric?.inlineErrorCount ?? 0} handled_refs=${inlineHandledCount}`
        })
      );
    }
  }
  return findings;
}

function repeatedStringFindings(
  stringLiterals: StringLiteralFact[],
  verbById: Map<string, ExtractedVerbRecord>,
  thresholds: CodeInsightReportConfig
): CodeInsightFinding[] {
  const groups = groupBy(
    stringLiterals.filter((literal) => literal.value.trim().length >= thresholds.minRepeatedStringLength),
    (literal) => `${literal.sourceVerbId}\t${literal.value}`
  );
  const findings: CodeInsightFinding[] = [];
  for (const rows of groups.values()) {
    if (rows.length < thresholds.minRepeatedStringCount) continue;
    const first = [...rows].sort(comparePosition)[0]!;
    const verb = verbById.get(first.sourceVerbId);
    findings.push({
      bucket: "repeated_literal_string",
      reason: "repeated_literal_string",
      refKind: "literal_string",
      ref: `${first.sourceVerbId} ${first.sourceObject}:${verb?.primaryName ?? first.sourceVerbId}`,
      sourceVerbId: first.sourceVerbId,
      ...(verb?.primaryName ? { sourceVerbName: verb.primaryName } : {}),
      sourceObject: first.sourceObject,
      sourcePath: first.sourcePath,
      line: first.line,
      column: first.column,
      count: rows.length,
      repeatedValue: first.value,
      detail: `string=${JSON.stringify(first.value.slice(0, 80))}`
    });
  }
  return findings;
}

async function similarVerbBodyFindings(
  verbs: ExtractedVerbRecord[],
  sourceExtractDir: string,
  thresholds: CodeInsightReportConfig
): Promise<CodeInsightFinding[]> {
  const programmed = verbs.filter((verb) => verb.hasProgram && verb.sourcePath);
  const groups = new Map<string, Array<{ verb: ExtractedVerbRecord; normalized: string; lineCount: number }>>();
  for (const verb of programmed) {
    const source = await readFile(join(sourceExtractDir, verb.sourcePath!), "utf8");
    const normalized = normalizeSourceForSimilarity(source);
    const lineCount = normalized.split(/\r?\n/).filter(Boolean).length;
    if (lineCount < thresholds.minNormalizedDuplicateLines) continue;
    const rows = groups.get(normalized) ?? [];
    rows.push({ verb, normalized, lineCount });
    groups.set(normalized, rows);
  }
  const findings: CodeInsightFinding[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const sorted = rows.sort((left, right) => left.verb.id.localeCompare(right.verb.id));
    const first = sorted[0]!;
    for (const duplicate of sorted.slice(1)) {
      findings.push({
        bucket: "similar_verb_body",
        reason: "similar_verb_body",
        refKind: "similar_verb",
        ref: `${duplicate.verb.id} ${duplicate.verb.object}:${duplicate.verb.primaryName}`,
        sourceVerbId: duplicate.verb.id,
        sourceVerbName: duplicate.verb.primaryName,
        sourceObject: duplicate.verb.object,
        sourcePath: duplicate.verb.sourcePath ?? "",
        line: 0,
        column: 0,
        count: duplicate.lineCount,
        relatedSourceVerbId: first.verb.id,
        relatedSourceVerbName: first.verb.primaryName,
        relatedSourceObject: first.verb.object,
        relatedSourcePath: first.verb.sourcePath,
        detail: `matches=${first.verb.id}`
      });
    }
  }
  return findings;
}

function variableInsightFinding(
  bucket: CodeInsightBucket,
  row: AssignmentFact,
  variableName: string,
  bindingKind: "assignment",
  bindingText: string,
  verb: ExtractedVerbRecord | undefined,
  extra: Partial<CodeInsightFinding> = {}
): CodeInsightFinding {
  return {
    bucket,
    reason: bucket,
    refKind: "identifier_binding",
    ref: `${row.sourceVerbId} ${row.sourceObject}:${verb?.primaryName ?? row.sourceVerbId} ${variableName}`,
    sourceVerbId: row.sourceVerbId,
    ...(verb?.primaryName ? { sourceVerbName: verb.primaryName } : {}),
    sourceObject: row.sourceObject,
    sourcePath: row.sourcePath,
    line: row.line,
    column: row.column,
    variableName,
    bindingKind,
    bindingText,
    ...extra
  };
}

function aggregateFinding(
  bucket: CodeInsightBucket,
  source: Pick<VerbMetricFact, "sourceVerbId" | "sourceObject" | "sourcePath"> & { line?: number; column?: number },
  verb: ExtractedVerbRecord | undefined,
  extra: Partial<CodeInsightFinding> = {}
): CodeInsightFinding {
  return {
    bucket,
    reason: bucket,
    refKind: "verb_aggregate",
    ref: `${source.sourceVerbId} ${source.sourceObject}:${verb?.primaryName ?? source.sourceVerbId}`,
    sourceVerbId: source.sourceVerbId,
    ...(verb?.primaryName ? { sourceVerbName: verb.primaryName } : {}),
    sourceObject: source.sourceObject,
    sourcePath: source.sourcePath,
    line: source.line ?? 0,
    column: source.column ?? 0,
    ...extra
  };
}

function readsByVerbVariableIndex(identifierRefs: IdentifierRefFact[]): Map<string, IdentifierRefFact[]> {
  return groupBy(identifierRefs, (ref) => `${ref.sourceVerbId}\t${ref.name.toLowerCase()}`);
}

function isArgumentHandlingIdentifier(name: string): boolean {
  return new Set(["args", "argstr", "dobj", "dobjstr", "iobj", "iobjstr", "prepstr"]).has(name.toLowerCase());
}

function isMooBuiltinContextIdentifier(name: string): boolean {
  return new Set(["args", "argstr", "dobj", "dobjstr", "iobj", "iobjstr", "prepstr", "player", "this"]).has(name.toLowerCase());
}

function topNames(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
}

function normalizeSourceForSimilarity(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/"([^"\\]|\\.)*"/g, "\"STR\"")
        .replace(/#[0-9]+/g, "#OBJ")
        .replace(/\b[0-9]+(?:\.[0-9]+)?\b/g, "NUM")
        .replace(/\s+/g, " ")
    )
    .filter(Boolean)
    .join("\n");
}

function comparePosition(left: { line: number; column: number }, right: { line: number; column: number }): number {
  return left.line - right.line || left.column - right.column;
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function summarizeBuckets(findings: CodeInsightFinding[], examplesPerBucket: number): CodeInsightBucketSummary[] {
  return codeInsightBuckets.map((bucket) => {
    const rows = findings.filter((finding) => finding.bucket === bucket);
    return {
      bucket,
      count: rows.length,
      examples: rows.slice(0, examplesPerBucket)
    };
  });
}

function compareFindings(left: CodeInsightFinding, right: CodeInsightFinding): number {
  if (left.bucket !== right.bucket) return codeInsightBuckets.indexOf(left.bucket) - codeInsightBuckets.indexOf(right.bucket);
  if (left.bucket === "high_complexity") return (right.cyclomaticComplexity ?? 0) - (left.cyclomaticComplexity ?? 0) || compareLocation(left, right);
  if (left.bucket === "large_verb") return (right.nonBlankLineCount ?? 0) - (left.nonBlankLineCount ?? 0) || compareLocation(left, right);
  if (left.bucket === "deep_nesting") return (right.maxControlFlowDepth ?? 0) - (left.maxControlFlowDepth ?? 0) || compareLocation(left, right);
  return compareLocation(left, right);
}

function compareLocation(left: CodeInsightFinding, right: CodeInsightFinding): number {
  return left.sourcePath.localeCompare(right.sourcePath) || left.sourceVerbId.localeCompare(right.sourceVerbId);
}

async function readManifest(resolvedDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(resolvedDir, "manifest.json"), "utf8")) as Record<string, unknown>;
}

async function readFactFile<T>(graphDir: string, fileName: string): Promise<T[]> {
  const path = join(graphDir, "code_facts", fileName);
  if (!existsSync(path)) return [];
  return readJsonl<T>(path);
}

function graphDirFromManifest(resolvedDir: string, manifest: Record<string, unknown>): string {
  if (typeof manifest.sourceGraphDir === "string") return resolve(manifest.sourceGraphDir);
  return resolve(join(resolvedDir, "..", "graph"));
}

async function loadVerbsIfExists(extractDir: string): Promise<ExtractedVerbRecord[]> {
  if (!existsSync(join(extractDir, "verbs.jsonl"))) return [];
  return loadVerbs(extractDir);
}
