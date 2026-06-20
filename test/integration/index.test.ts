import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  formatCoverageReport,
  formatReceiverExplanation,
  formatCallerQuery,
  formatCodeInsightsReport,
  formatIssueContext,
  formatIssuesReport,
  formatMutationInvariantsReport,
  formatUnprogrammedVerbsReport,
  formatUnusedVerbsReport,
  formatRefQuery,
  formatSourceVerbQuery,
  formatUnresolvedReport,
  formatVerbContext,
  buildIssueWebReport,
  contextForIssue,
  contextForVerb,
  defaultReportConfig,
  explainReceiver,
  formatIssueWebReportHtml,
  indexMooCodeGraph,
  inspectExtractDir,
  loadReportConfig,
  queryCallers,
  queryRefs,
  querySourceVerb,
  reportCodeInsights,
  reportCoverage,
  reportIssues,
  reportMutationInvariants,
  reportUnprogrammedVerbs,
  reportUnusedVerbs,
  reportUnresolved,
  resolveMooCodeGraph,
  serveIssueWebReport,
  validateExtractDir
} from "../../src/index.js";
import { classifyRhsShape, effectivePropertyValue } from "../../src/report/reportMutationInvariants.js";
import { createReportsApp } from "../../src/web/dynamicReportServer.js";
import { materializeReportRun, readReportItems, readReportSummary } from "../../src/web/reportStore.js";

const fixture = resolve("test/fixtures/extract-basic");
const syntaxRichFixture = resolve("test/fixtures/extract-syntax-rich");

test("validate passes fixture", async () => {
  const result = await validateExtractDir(fixture);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("inspect returns expected counts", async () => {
  const result = await inspectExtractDir(fixture);
  assert.equal(result.snapshotId, "test-snapshot");
  assert.equal(result.verbCount, 18);
  assert.equal(result.programmedVerbCount, 3);
  assert.equal(result.verbCodeFileCount, 3);
  assert.equal(result.objectsCount, 7);
  assert.equal(result.coreCandidateCount, 7);
  assert.deepEqual(result.missingSourceFiles, []);
});

test("report config uses defaults when no YAML file exists", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "moo-code-graph-config-"));
  try {
    const loaded = await loadReportConfig(join(rootDir, "missing.yaml"));
    assert.equal(loaded.path, undefined);
    assert.equal(loaded.hash, undefined);
    assert.equal(loaded.config.reports.codeInsights.includeUnusedDestructuringArgsWhenOtherArgsAreUsed, false);
    assert.deepEqual(loaded.config, defaultReportConfig);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("report config loads YAML overrides and rejects unknown keys", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "moo-code-graph-config-"));
  try {
    const configPath = join(rootDir, "moo-code-graph.yaml");
    await writeFile(
      configPath,
      [
        "reports:",
        "  codeInsights:",
        "    deepBranchHotspotDepth: 6",
        "    minFanOut: 9",
        "    includeUnusedDestructuringArgsWhenOtherArgsAreUsed: true",
        "  deadCode:",
        "    unusedVerbs:",
        "      requireExecute: true",
        ""
      ].join("\n"),
      "utf8"
    );

    const loaded = await loadReportConfig(configPath);
    assert.equal(loaded.path, configPath);
    assert.match(loaded.hash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(loaded.config.reports.codeInsights.minFanOut, 9);
    assert.equal(loaded.config.reports.codeInsights.includeUnusedDestructuringArgsWhenOtherArgsAreUsed, true);
    assert.equal(loaded.config.reports.deadCode.unusedVerbs.programmaticOnly, true);
    assert.equal(loaded.config.reports.deadCode.unusedVerbs.requireExecute, true);

    const invalidPath = join(rootDir, "invalid.yaml");
    await writeFile(invalidPath, "reports:\n  codeInsights:\n    nope: 1\n", "utf8");
    await assert.rejects(() => loadReportConfig(invalidPath), /Unknown report config key reports\.codeInsights\.nope/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("mutation invariant shape helpers classify narrow literals and inherited clear values", () => {
  assert.equal(classifyRhsShape('"ready"'), "string");
  assert.equal(classifyRhsShape("42"), "int");
  assert.equal(classifyRhsShape("4.2"), "float");
  assert.equal(classifyRhsShape("#30"), "object");
  assert.equal(classifyRhsShape("{#1, #2}"), "list");
  assert.equal(classifyRhsShape('["a" -> 1]'), "map");
  assert.equal(classifyRhsShape("E_PERM"), "error");
  assert.equal(classifyRhsShape("caller_perms()"), "unknown");
  assert.equal(classifyRhsShape("some_var"), "unknown");

  const objects = new Map([
    ["#1", { id: "#1", parents: ["#-1"] }],
    ["#2", { id: "#2", parents: ["#1"] }],
    ["#3", { id: "#3", parents: ["#2"] }],
    ["#4", { id: "#4", parents: ["#5"] }],
    ["#5", { id: "#5", parents: ["#4"] }]
  ]);
  const values = new Map([
    ["#1\u0000foo", { object: "#1", name: "foo", value: { type: "string" } }],
    ["#2\u0000foo", { object: "#2", name: "foo", value: { type: "clear" } }],
    ["#3\u0000foo", { object: "#3", name: "foo", value: { type: "clear" } }],
    ["#4\u0000bar", { object: "#4", name: "bar", value: { type: "clear" } }],
    ["#5\u0000bar", { object: "#5", name: "bar", value: { type: "clear" } }]
  ]);

  assert.deepEqual(effectivePropertyValue("#1", "foo", objects, values), { object: "#1", source: "direct", shape: "string", preview: '""' });
  assert.deepEqual(effectivePropertyValue("#2", "foo", objects, values), { object: "#1", source: "inherited", shape: "string", preview: '""' });
  assert.deepEqual(effectivePropertyValue("#3", "foo", objects, values), { object: "#1", source: "inherited", shape: "string", preview: '""' });
  assert.equal(effectivePropertyValue("#4", "bar", objects, values), undefined);
});

test("mutation invariants report emits high-confidence mismatches and honors config suppressions", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "moo-code-graph-mutation-"));
  try {
    const extractDir = join(rootDir, "extract");
    const graphDir = join(rootDir, "graph");
    const resolvedDir = join(rootDir, "resolved");
    await mkdir(join(extractDir, "verb_code"), { recursive: true });
    await mkdir(join(graphDir, "code_facts"), { recursive: true });
    await mkdir(join(resolvedDir, "edges"), { recursive: true });
    const sourcePath = "verb_code/0000000010.0000.mutate.test.moo";
    await writeFile(
      join(extractDir, sourcePath),
      ['this.foo = "bad";', "this.items = 1;", "this.items = {player};", "this.foo = caller_perms();", 'this.unknown = "bad";', ""].join("\n"),
      "utf8"
    );
    await writeJsonl(join(extractDir, "objects.jsonl"), [
      { kind: "object", objectId: 1, id: "#1", parents: ["#-1"], children: ["#10"], owner: "#2", recycled: false },
      { kind: "object", objectId: 10, id: "#10", parents: ["#1"], children: [], owner: "#2", recycled: false }
    ]);
    await writeJsonl(join(extractDir, "properties.jsonl"), [
      { kind: "property_definition", id: "#10.foo", objectId: 10, object: "#10", name: "foo", definitionIndex: 0 },
      { kind: "property_definition", id: "#10.items", objectId: 10, object: "#10", name: "items", definitionIndex: 1 },
      { kind: "property_definition", id: "#10.unknown", objectId: 10, object: "#10", name: "unknown", definitionIndex: 2 }
    ]);
    await writeJsonl(join(extractDir, "property_values.jsonl"), [
      { kind: "property_value", objectId: 10, object: "#10", propertyIndex: 0, name: "foo", owner: "#2", value: { type: "integer", value: 0 } },
      { kind: "property_value", objectId: 10, object: "#10", propertyIndex: 1, name: "items", owner: "#2", value: { type: "list", items: [{ type: "object", object: "#1" }], objectRefs: ["#1"] } }
    ]);
    await writeJsonl(join(extractDir, "verbs.jsonl"), [
      { kind: "verb", id: "#10:0", object: "#10", names: ["mutate"], primaryName: "mutate", sourcePath, hasProgram: true }
    ]);
    await writeJsonl(join(graphDir, "code_facts", "assignments.jsonl"), [
      assignment("#10:0", "#10", sourcePath, 0, "this.foo", '"bad"'),
      assignment("#10:0", "#10", sourcePath, 1, "this.items", "1"),
      assignment("#10:0", "#10", sourcePath, 2, "this.items", "{player}"),
      assignment("#10:0", "#10", sourcePath, 3, "this.foo", "caller_perms()"),
      assignment("#10:0", "#10", sourcePath, 4, "this.unknown", '"bad"')
    ]);
    await writeFile(join(resolvedDir, "manifest.json"), JSON.stringify({ sourceExtractDir: extractDir, sourceGraphDir: graphDir }) + "\n", "utf8");
    await writeJsonl(join(resolvedDir, "edges", "property_candidate_edges.jsonl"), [
      propertyWrite("#10:0", "#10", sourcePath, 0, "foo", "#10.foo"),
      propertyWrite("#10:0", "#10", sourcePath, 1, "items", "#10.items"),
      propertyWrite("#10:0", "#10", sourcePath, 2, "items", "#10.items"),
      propertyWrite("#10:0", "#10", sourcePath, 3, "foo", "#10.foo"),
      propertyWrite("#10:0", "#10", sourcePath, 4, "unknown", "#10.unknown")
    ]);

    const report = await reportMutationInvariants({ resolvedDir, examplesPerBucket: 10 });
    assert.equal(report.total, 2);
    assert.equal(report.buckets.find((bucket) => bucket.bucket === "shape_mismatch")?.count, 1);
    assert.equal(report.buckets.find((bucket) => bucket.bucket === "object_scalar_mismatch")?.count, 1);
    assert(formatMutationInvariantsReport(report).includes("this.foo"));
    assert(formatMutationInvariantsReport(report).includes("current=0"));
    assert.equal(report.buckets.find((bucket) => bucket.bucket === "object_scalar_mismatch")?.examples[0]?.effectiveValuePreview, "{#1}");

    const suppressed = await reportMutationInvariants({
      resolvedDir,
      examplesPerBucket: 10,
      config: { enabled: true, ignoreProperties: ["*.foo"], ignoreSourceVerbs: [], ignoreBuckets: ["object_scalar_mismatch"] }
    });
    assert.equal(suppressed.total, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("index creates output files and raw facts", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "moo-code-graph-"));
  await rm(outputDir, { recursive: true, force: true });
  try {
    const result = await indexMooCodeGraph({ extractDir: fixture, outputDir, overwrite: true });
    for (const path of [
      "manifest.json",
      "code_facts/callsites.jsonl",
      "code_facts/function_calls.jsonl",
      "code_facts/object_refs.jsonl",
      "code_facts/system_object_refs.jsonl",
      "code_facts/property_accesses.jsonl",
      "code_facts/assignments.jsonl",
      "code_facts/local_bindings.jsonl",
      "code_facts/destructuring_bindings.jsonl",
      "code_facts/loop_bindings.jsonl",
      "code_facts/branch_guards.jsonl",
      "code_facts/verb_metrics.jsonl",
      "code_facts/identifier_refs.jsonl",
      "code_facts/string_literals.jsonl",
      "code_facts/comments.jsonl",
      "code_facts/parse_errors.jsonl",
      "code_facts/stats.json"
    ]) {
      assert.equal(existsSync(join(outputDir, path)), true, path);
    }

    assert.equal(result.stats.callsiteCount, 61);
    assert.equal(result.stats.functionCallCount, 16);
    assert.equal(result.stats.objectRefCount, 30);
    assert.equal(result.stats.systemObjectRefCount, 38);
    assert.equal(result.stats.propertyAccessCount, 62);
    assert.equal(result.stats.assignmentCount, 48);
    assert.equal(result.stats.localBindingCount, 15);
    assert.equal(result.stats.destructuringBindingCount, 4);
    assert.equal(result.stats.loopBindingCount, 6);
    assert.equal(result.stats.branchGuardCount, 36);
    assert.equal(result.stats.verbMetricCount, 3);
    assert.equal(result.stats.identifierRefCount, 145);
    assert.equal(result.stats.stringLiteralCount, 23);
    assert.equal(result.stats.parseErrorCount, 0);

    const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")) as Record<string, string>;
    assert.equal(manifest.factSchemaVersion, "raw-code-facts/v7");

    const callsites = await readJsonl(join(outputDir, "code_facts/callsites.jsonl"));
    assert(callsites.some((fact) => fact.receiverKind === "this" && fact.selector === "render"));
    assert(
      callsites.some(
        (fact) =>
          fact.receiverKind === "this" &&
          fact.selector === "optional_e_verbnf" &&
          fact.inlineErrorHandled === true &&
          Array.isArray(fact.inlineErrorCodes) &&
          fact.inlineErrorCodes.includes("E_VERBNF")
      )
    );
    assert(
      callsites.some(
        (fact) =>
          fact.receiverKind === "this" &&
          fact.selector === "optional_default" &&
          fact.inlineErrorHandled === true &&
          Array.isArray(fact.inlineErrorCodes) &&
          fact.inlineErrorCodes.includes("ANY") &&
          fact.inlineErrorFallbackText === "0"
      )
    );
    assert(callsites.some((fact) => fact.receiverKind === "player" && fact.selector === "tell"));
    assert(callsites.some((fact) => fact.receiverKind === "system_object" && fact.receiverRaw === "$String_Utils" && fact.selector === "trim"));
    assert(callsites.some((fact) => fact.receiverKind === "system_object" && fact.receiverRaw === "$missing"));
    assert(callsites.some((fact) => fact.receiverKind === "literal_object" && fact.selector === "notify"));
    assert(callsites.some((fact) => fact.receiverKind === "literal_object" && fact.selector === "sh"));
    assert(callsites.some((fact) => fact.receiverKind === "variable" && fact.selector === "foo"));
    assert(callsites.some((fact) => fact.receiverKind === "variable" && fact.receiverRaw === "local_obj" && fact.selector === "notify"));
    assert(callsites.some((fact) => fact.receiverKind === "variable" && fact.receiverRaw === "LOCAL_CORE" && fact.selector === "trim"));
    assert(callsites.some((fact) => fact.receiverKind === "variable" && fact.receiverRaw === "local_location" && fact.selector === "local"));
    assert(callsites.some((fact) => fact.receiverKind === "variable" && fact.receiverRaw === "list_item" && fact.selector === "local"));
    assert(callsites.some((fact) => fact.receiverKind === "variable" && fact.receiverRaw === "child_item" && fact.selector === "local"));
    assert(callsites.some((fact) => fact.receiverKind === "variable" && fact.selectorKind === "dynamic" && fact.selectorExpression === "verb_name"));
    assert(callsites.some((fact) => fact.receiverKind === "system_object" && fact.receiverRaw === "$ou" && fact.selector === "isa"));
    assert(callsites.some((fact) => fact.receiverKind === "system_object" && fact.receiverRaw === "$object_utils" && fact.selector === "isa"));
    assert(callsites.some((fact) => fact.receiverKind === "variable" && fact.receiverRaw === "x" && fact.selector === "boosted"));
    assert(callsites.some((fact) => fact.receiverKind === "variable" && fact.receiverRaw === "guarded_player" && fact.selector === "boosted"));

    const functionCalls = await readJsonl(join(outputDir, "code_facts/function_calls.jsonl"));
    assert(functionCalls.some((fact) => fact.function === "tostr"));
    assert(functionCalls.some((fact) => fact.function === "children" && fact.argumentsText === "(local_obj)"));
    assert(functionCalls.some((fact) => fact.function === "isa" && fact.argumentsText === "(z, #40)"));
    assert(
      functionCalls.some(
        (fact) =>
          fact.function === "$bf_max_object" &&
          fact.inlineErrorHandled === true &&
          Array.isArray(fact.inlineErrorCodes) &&
          fact.inlineErrorCodes.includes("E_VERBNF") &&
          fact.inlineErrorFallbackText === "#-1"
      )
    );

    const objectRefs = await readJsonl(join(outputDir, "code_facts/object_refs.jsonl"));
    assert(objectRefs.some((fact) => fact.object === "#30"));

    const systemObjectRefs = await readJsonl(join(outputDir, "code_facts/system_object_refs.jsonl"));
    assert(systemObjectRefs.some((fact) => fact.symbol === "$String_Utils"));
    assert(systemObjectRefs.some((fact) => fact.symbol === "$missing"));

    const propertyAccesses = await readJsonl(join(outputDir, "code_facts/property_accesses.jsonl"));
    assert(propertyAccesses.some((fact) => fact.accessKind === "read" && fact.property === "foo"));
    assert(propertyAccesses.some((fact) => fact.accessKind === "write" && fact.property === "foo"));
    assert(propertyAccesses.some((fact) => fact.receiverRaw === "$string_utils" && fact.property === "coreprop"));
    assert(propertyAccesses.some((fact) => fact.receiverRaw === "#40" && fact.property === "shared"));
    assert(propertyAccesses.some((fact) => fact.receiverRaw === "local_location" && fact.property === "shared"));
    assert(propertyAccesses.some((fact) => fact.receiverRaw === "list_item" && fact.property === "shared"));
    assert(propertyAccesses.some((fact) => fact.receiverRaw === "x" && fact.property === "interference_modifier"));
    assert(propertyAccesses.some((fact) => fact.receiverRaw === "guarded_player" && fact.property === "location"));
    assert(
      propertyAccesses.some(
        (fact) =>
          fact.receiverRaw === "this" &&
          fact.property === "missing_prop" &&
          fact.inlineErrorHandled === true &&
          Array.isArray(fact.inlineErrorCodes) &&
          fact.inlineErrorCodes.includes("E_PROPNF") &&
          fact.inlineErrorFallbackText === "0"
      )
    );
    assert(propertyAccesses.some((fact) => fact.kind === "computed_property_access" && fact.propertyExpression === "prop_name"));

    const assignments = await readJsonl(join(outputDir, "code_facts/assignments.jsonl"));
    assert(assignments.some((fact) => fact.leftText === "x" && fact.rightText === "this.foo"));
    assert(assignments.some((fact) => fact.leftText === "this.foo" && fact.rightText === "x"));

    const localBindings = await readJsonl(join(outputDir, "code_facts/local_bindings.jsonl"));
    assert(localBindings.some((fact) => fact.variable === "local_obj" && fact.bindingKind === "literal_object" && fact.object === "#30"));
    assert(localBindings.some((fact) => fact.variable === "local_core" && fact.bindingKind === "system_object" && fact.symbol === "$STRING_UTILS"));
    assert(localBindings.some((fact) => fact.variable === "local_this" && fact.bindingKind === "this"));

    const destructuringBindings = await readJsonl(join(outputDir, "code_facts/destructuring_bindings.jsonl"));
    assert(destructuringBindings.some((fact) => fact.variable === "destructured_obj" && fact.patternText === "{destructured_obj, destructured_name}"));
    assert(destructuringBindings.some((fact) => fact.variable === "guarded_player" && fact.patternText === "{guarded_player, ignored_guard}"));

    const loopBindings = await readJsonl(join(outputDir, "code_facts/loop_bindings.jsonl"));
    assert(loopBindings.some((fact) => fact.variable === "item" && fact.collectionText === "local_obj.contents" && fact.collectionKind === "contents_property"));
    assert(loopBindings.some((fact) => fact.variable === "list_item" && fact.collectionText === "(local_obj.items)" && fact.collectionKind === "unknown"));
    assert(loopBindings.some((fact) => fact.variable === "refined_item" && fact.collectionText === "(local_obj.items)" && fact.collectionKind === "unknown"));
    assert(loopBindings.some((fact) => fact.variable === "child_item" && fact.collectionText === "children(local_obj)" && fact.collectionKind === "unknown"));

    const branchGuards = await readJsonl(join(outputDir, "code_facts/branch_guards.jsonl"));
    assert(branchGuards.some((fact) => fact.guardKind === "isa" && fact.variable === "x" && fact.targetRaw === "$freq_booster" && fact.guardText === "$ou:isa(x, $freq_booster)"));
    assert(branchGuards.some((fact) => fact.variable === "x" && fact.guardPolarity === "positive" && fact.guardScope === "branch"));
    assert(branchGuards.some((fact) => fact.variable === "y" && fact.guardText === "$object_utils:isa(y, $freq_booster)"));
    assert(branchGuards.some((fact) => fact.variable === "z" && fact.targetKind === "literal_object" && fact.targetRaw === "#40"));
    assert(branchGuards.some((fact) => fact.guardKind === "isa" && fact.receiverKind === "property_access" && fact.receiverRaw === "phone_holder.phone" && fact.targetRaw === "$freq_booster"));
    assert(branchGuards.some((fact) => fact.variable === "refined_item" && fact.targetKind === "literal_object" && fact.targetRaw === "#30"));
    assert(branchGuards.some((fact) => fact.variable === "guarded_player" && fact.guardPolarity === "negative" && fact.guardScope === "sibling_continuation" && fact.terminalKind === "return"));
    assert(branchGuards.some((fact) => fact.variable === "guarded_player" && fact.guardPolarity === "negative" && fact.guardScope === "post_continuation" && fact.terminalKind === "return"));
    assert(branchGuards.some((fact) => fact.guardKind === "has_property" && fact.receiverRaw === "this" && fact.property === "namec" && fact.guardScope === "conditional_expression"));
    assert(branchGuards.some((fact) => fact.guardKind === "has_property" && fact.receiverRaw === "runtime_hp" && fact.property === "p" && fact.guardScope === "branch"));
    assert(branchGuards.some((fact) => fact.guardKind === "has_property" && fact.receiverRaw === "exit_hp" && fact.property === "p" && fact.guardScope === "post_continuation"));
    assert(branchGuards.some((fact) => fact.guardKind === "has_callable_verb" && fact.receiverRaw === "runtime_callable" && fact.verb === "boosted" && fact.guardScope === "branch"));
    assert(branchGuards.some((fact) => fact.guardKind === "has_verb" && fact.receiverRaw === "runtime_cond" && fact.verb === "boosted" && fact.guardScope === "conditional_expression"));
    assert(branchGuards.some((fact) => fact.guardKind === "has_callable_verb" && fact.receiverRaw === "exit_callable" && fact.verb === "boosted" && fact.guardScope === "post_continuation"));
    assert(branchGuards.some((fact) => fact.guardKind === "valid" && fact.variable === "valid_target" && fact.guardScope === "conditional_expression"));
    assert(branchGuards.some((fact) => fact.guardKind === "valid" && fact.variable === "valid_branch" && fact.guardScope === "branch"));
    assert(branchGuards.some((fact) => fact.guardKind === "valid" && fact.variable === "valid_exit" && fact.guardScope === "post_continuation"));
    assert(branchGuards.some((fact) => fact.guardKind === "valid" && fact.variable === "recycler_target" && fact.guardScope === "conditional_expression" && fact.guardText === "$recycler:valid(recycler_target)"));
    assert(branchGuards.some((fact) => fact.guardKind === "valid" && fact.variable === "recycler_branch" && fact.guardScope === "branch" && fact.guardText === "$recycler:valid(recycler_branch)"));
    assert(branchGuards.some((fact) => fact.guardKind === "valid" && fact.variable === "recycler_exit" && fact.guardScope === "post_continuation" && fact.guardText === "$recycler:valid(recycler_exit)"));
    assert(branchGuards.some((fact) => fact.guardKind === "match_failure" && fact.variable === "match_branch" && fact.guardPolarity === "negative" && fact.guardScope === "branch"));
    assert(branchGuards.some((fact) => fact.guardKind === "match_failure" && fact.variable === "match_exit" && fact.guardPolarity === "positive" && fact.guardScope === "post_continuation"));
    assert(branchGuards.some((fact) => fact.guardKind === "match_failure" && fact.variable === "match_assigned" && fact.guardPolarity === "positive" && fact.guardScope === "post_continuation"));
    assert(!branchGuards.some((fact) => fact.guardKind === "has_property" && fact.receiverRaw === "dyn_hp"));
    assert(!branchGuards.some((fact) => fact.guardKind === "has_callable_verb" && fact.receiverRaw === "dynamic_callable"));
    assert(!branchGuards.some((fact) => fact.variable === "no_or"));

    const comments = await readJsonl(join(outputDir, "code_facts/comments.jsonl"));
    assert.equal(comments.length, 1);

    const verbMetrics = await readJsonl(join(outputDir, "code_facts/verb_metrics.jsonl"));
    const testMetrics = verbMetrics.find((fact) => fact.sourceVerbId === "#20:0");
    assert(testMetrics);
    assert.equal(testMetrics.kind, "verb_metric");
    assert(Number(testMetrics.cyclomaticComplexity) > 1);
    assert(Number(testMetrics.nonBlankLineCount) > 0);
    assert(Number(testMetrics.statementCount) > 0);

    const identifierRefs = await readJsonl(join(outputDir, "code_facts/identifier_refs.jsonl"));
    assert.equal(identifierRefs.length, 145);
    assert(identifierRefs.some((fact) => fact.name === "local_obj" && fact.refContext === "read"));
    assert(!identifierRefs.some((fact) => fact.name === "destructured_name"));

    const stringLiterals = await readJsonl(join(outputDir, "code_facts/string_literals.jsonl"));
    assert.equal(stringLiterals.length, 23);
    assert(stringLiterals.some((fact) => fact.value === "Done" && fact.rawText === "\"Done\""));

    const parseErrors = await readJsonl(join(outputDir, "code_facts/parse_errors.jsonl"));
    assert.equal(parseErrors.length, 0);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("resolve creates conservative identity edges and unresolved refs", async () => {
  const graphDir = await mkdtemp(join(tmpdir(), "moo-code-graph-resolve-graph-"));
  const resolvedDir = await mkdtemp(join(tmpdir(), "moo-code-graph-resolve-out-"));
  await rm(graphDir, { recursive: true, force: true });
  await rm(resolvedDir, { recursive: true, force: true });
  try {
    await indexMooCodeGraph({ extractDir: fixture, outputDir: graphDir, overwrite: true });
    const result = await resolveMooCodeGraph({ extractDir: fixture, graphDir, outputDir: resolvedDir, overwrite: true });
    assert.equal(existsSync(join(resolvedDir, "findings/unresolved_verb_calls.jsonl")), true);
    assert.equal(existsSync(join(resolvedDir, "edges/root_property_edges.jsonl")), true);
    assert.equal(existsSync(join(resolvedDir, "edges/root_verb_call_edges.jsonl")), true);
    assert.equal(existsSync(join(resolvedDir, "edges/property_candidate_edges.jsonl")), true);
    assert.equal(existsSync(join(resolvedDir, "edges/guarded_property_access_edges.jsonl")), true);
    assert.equal(existsSync(join(resolvedDir, "edges/guarded_verb_call_edges.jsonl")), true);
    assert.equal(existsSync(join(resolvedDir, "findings/unresolved_property_accesses.jsonl")), true);
    assert.equal(existsSync(join(resolvedDir, "flow/local_variable_states.jsonl")), true);
    assert.equal(existsSync(join(resolvedDir, "flow/inferred_receiver_candidates.jsonl")), true);

    assert.equal(result.stats.systemObjectRefCount, 38);
    assert.equal(result.stats.resolvedSystemObjectRefCount, 32);
    assert.equal(result.stats.unresolvedSystemObjectRefCount, 1);
    assert.equal(result.stats.rootPropertyRefCount, 2);
    assert.equal(result.stats.resolvedRootPropertyRefCount, 2);
    assert.equal(result.stats.rootVerbFunctionCallCount, 3);
    assert.equal(result.stats.resolvedRootVerbFunctionCallCount, 1);
    assert.equal(result.stats.unresolvedRootVerbFunctionCallCount, 2);
    assert.equal(result.stats.literalObjectRefCount, 30);
    assert.equal(result.stats.resolvedLiteralObjectRefCount, 27);
    assert.equal(result.stats.unresolvedLiteralObjectRefCount, 3);
    assert.equal(result.stats.staticVerbCallsiteCount, 54);
    assert.equal(result.stats.resolvedVerbCallCandidateCount, 43);
    assert.equal(result.stats.inheritedVerbCallCandidateCount, 8);
    assert.equal(result.stats.guardedVerbCallCount, 3);
    assert.equal(result.stats.unresolvedVerbCallCandidateCount, 8);
    assert.equal(result.stats.staticPropertyAccessCount, 56);
    assert.equal(result.stats.resolvedPropertyCandidateCount, 31);
    assert.equal(result.stats.inheritedPropertyCandidateCount, 7);
    assert.equal(result.stats.builtInPropertyCandidateCount, 7);
    assert.equal(result.stats.guardedPropertyAccessCount, 5);
    assert.equal(result.stats.unresolvedPropertyAccessCount, 28);
    assert.equal(result.stats.localVariableStateCount, 73);
    assert.equal(result.stats.inferredReceiverCandidateCount, 40);

    const manifest = JSON.parse(await readFile(join(resolvedDir, "manifest.json"), "utf8")) as Record<string, string>;
    assert.equal(manifest.resolutionSchemaVersion, "resolved-reference-edges/v5");
    assert.equal(manifest.sourceFactSchemaVersion, "raw-code-facts/v7");

    const systemEdges = await readJsonl(join(resolvedDir, "edges/system_object_edges.jsonl"));
    assert(systemEdges.some((edge) => edge.symbol === "$String_Utils" && edge.targetObject === "#30" && edge.context === "verb_call_receiver"));

    const rootPropertyEdges = await readJsonl(join(resolvedDir, "edges/root_property_edges.jsonl"));
    assert(rootPropertyEdges.some((edge) => edge.symbol === "$root_status" && edge.propertyId === "#0.root_status" && edge.accessKind === "write"));
    assert(rootPropertyEdges.some((edge) => edge.symbol === "$root_status" && edge.propertyId === "#0.root_status" && edge.accessKind === "read"));

    const rootVerbCallEdges = await readJsonl(join(resolvedDir, "edges/root_verb_call_edges.jsonl"));
    assert(rootVerbCallEdges.some((edge) => edge.function === "$critical" && edge.selector === "critical" && edge.targetVerbId === "#0:0"));

    const literalEdges = await readJsonl(join(resolvedDir, "edges/literal_object_edges.jsonl"));
    assert(literalEdges.some((edge) => edge.object === "#30" && edge.targetObject === "#30"));
    assert(literalEdges.some((edge) => edge.object === "#-1" && edge.targetObject === "#-1" && edge.resolutionKind === "special_literal_object" && edge.specialName === "$nothing"));
    assert(literalEdges.some((edge) => edge.object === "#-2" && edge.targetObject === "#-2" && edge.resolutionKind === "special_literal_object" && edge.specialName === "$ambiguous_match"));
    assert(literalEdges.some((edge) => edge.object === "#-3" && edge.targetObject === "#-3" && edge.resolutionKind === "special_literal_object" && edge.specialName === "$failed_match"));

    const verbCallEdges = await readJsonl(join(resolvedDir, "edges/verb_call_candidate_edges.jsonl"));
    assert(verbCallEdges.every((edge) => edge.sourceVerbName === "test"));
    assert(verbCallEdges.some((edge) => edge.sourceVerbName === "test" && edge.receiverKind === "system_object" && edge.receiverRaw === "$String_Utils" && edge.receiverObject === "#30" && edge.selector === "trim" && edge.targetVerbId === "#30:0" && edge.inheritanceDepth === 0));
    assert(verbCallEdges.some((edge) => edge.receiverKind === "literal_object" && edge.receiverRaw === "#30" && edge.receiverObject === "#30" && edge.selector === "notify" && edge.targetVerbId === "#30:1" && edge.inheritanceDepth === 0));
    assert(verbCallEdges.some((edge) => edge.receiverRaw === "#30" && edge.receiverObject === "#30" && edge.selector === "sh" && edge.targetVerbId === "#30:2" && edge.inheritanceDepth === 0));
    assert(verbCallEdges.some((edge) => edge.receiverRaw === "#40" && edge.receiverObject === "#40" && edge.selector === "local" && edge.targetVerbId === "#30:3" && edge.definedOn === "#30" && edge.inheritanceDepth === 1));
    assert(verbCallEdges.some((edge) => edge.receiverRaw === "#40" && edge.receiverObject === "#40" && edge.selector === "match" && edge.targetVerbId === "#1:0" && edge.definedOn === "#1" && edge.inheritanceDepth === 2 && JSON.stringify(edge.inheritancePath) === JSON.stringify(["#40", "#30", "#1"])));
    assert(verbCallEdges.some((edge) => edge.receiverRaw === "#40" && edge.receiverObject === "#40" && edge.selector === "wi" && edge.targetVerbId === "#1:1" && edge.definedOn === "#1" && edge.inheritanceDepth === 2));
    assert(verbCallEdges.some((edge) => edge.receiverKind === "this" && edge.receiverRaw === "THIS" && edge.receiverObject === "#20" && edge.selector === "test" && edge.targetVerbId === "#20:0" && edge.resolutionKind === "this_static_selector" && edge.inheritanceDepth === 0));
    assert(verbCallEdges.some((edge) => edge.receiverKind === "this" && edge.receiverRaw === "this" && edge.receiverObject === "#20" && edge.selector === "match" && edge.targetVerbId === "#1:0" && edge.resolutionKind === "this_inherited_static_selector" && edge.inheritanceDepth === 1 && JSON.stringify(edge.inheritancePath) === JSON.stringify(["#20", "#1"])));
    assert(verbCallEdges.some((edge) => edge.receiverKind === "this" && edge.receiverRaw === "this" && edge.receiverObject === "#20" && edge.selector === "wi" && edge.targetVerbId === "#1:1" && edge.resolutionKind === "this_inherited_static_selector" && edge.inheritanceDepth === 1));
    assert(verbCallEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "local_obj" && edge.receiverObject === "#30" && edge.selector === "notify" && edge.targetVerbId === "#30:1"));
    assert(verbCallEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "LOCAL_CORE" && edge.receiverObject === "#30" && edge.selector === "trim" && edge.targetVerbId === "#30:0"));
    assert(verbCallEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "local_location" && edge.receiverObject === "#40" && edge.selector === "local" && edge.targetVerbId === "#30:3"));
    assert(verbCallEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "list_item" && edge.receiverObject === "#40" && edge.selector === "local" && edge.targetVerbId === "#30:3"));
    assert(verbCallEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "child_item" && edge.receiverObject === "#40" && edge.selector === "local" && edge.targetVerbId === "#30:3"));
    assert(verbCallEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "refined_item" && edge.receiverObject === "#40" && edge.selector === "boosted" && edge.targetVerbId === "#40:0"));
    assert(verbCallEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "x" && edge.receiverObject === "#40" && edge.selector === "boosted" && edge.targetVerbId === "#40:0"));
    assert(verbCallEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "guarded_player" && edge.receiverObject === "#40" && edge.selector === "boosted" && edge.targetVerbId === "#40:0"));

    const unresolved = await readJsonl(join(resolvedDir, "edges/unresolved_refs.jsonl"));
    assert(unresolved.every((ref) => ref.sourceVerbName === "test"));
    assert(unresolved.some((ref) => ref.refKind === "system_object" && ref.ref === "$missing" && ref.reason === "no_core_candidate"));
    assert(unresolved.some((ref) => ref.refKind === "literal_object" && ref.ref === "#999" && ref.reason === "missing_object"));
    assert(unresolved.some((ref) => ref.refKind === "literal_object" && ref.ref === "#-4" && ref.reason === "missing_object"));
    assert(!unresolved.some((ref) => ref.refKind === "literal_object" && (ref.ref === "#-1" || ref.ref === "#-2" || ref.ref === "#-3")));
    assert(unresolved.some((ref) => ref.refKind === "verb_call" && ref.ref === "$missing:noop" && ref.reason === "no_core_candidate"));
    assert(unresolved.some((ref) => ref.refKind === "verb_call" && ref.ref === "this:missing" && ref.receiverObject === "#20" && ref.reason === "no_matching_direct_or_inherited_verb"));
    assert(
      unresolved.some(
        (ref) =>
          ref.refKind === "verb_call" &&
          ref.ref === "this:optional_e_verbnf" &&
          ref.reason === "no_matching_direct_or_inherited_verb" &&
          ref.inlineErrorHandled === true &&
          Array.isArray(ref.inlineErrorCodes) &&
          ref.inlineErrorCodes.includes("E_VERBNF")
      )
    );
    assert(
      unresolved.some(
        (ref) =>
          ref.refKind === "verb_call" &&
          ref.ref === "this:optional_default" &&
          ref.reason === "no_matching_direct_or_inherited_verb" &&
          ref.inlineErrorHandled === true &&
          ref.inlineErrorFallbackText === "0"
      )
    );
    assert(unresolved.some((ref) => ref.refKind === "verb_call" && ref.ref === "this:render" && ref.receiverObject === "#20" && ref.reason === "no_matching_direct_or_inherited_verb"));
    assert(unresolved.some((ref) => ref.refKind === "verb_call" && ref.ref === "#999:notify" && ref.reason === "missing_object"));
    assert(unresolved.some((ref) => ref.refKind === "verb_call" && ref.ref === "#50:missing" && ref.reason === "ancestor_cycle"));
    assert(unresolved.some((ref) => ref.refKind === "verb_call" && ref.ref === "$missing_root_verb" && ref.receiverObject === "#0" && ref.reason === "no_matching_direct_or_inherited_verb"));
    assert(
      unresolved.some(
        (ref) =>
          ref.refKind === "verb_call" &&
          ref.ref === "$bf_max_object" &&
          ref.receiverObject === "#0" &&
          ref.reason === "no_matching_direct_or_inherited_verb" &&
          ref.inlineErrorHandled === true &&
          Array.isArray(ref.inlineErrorCodes) &&
          ref.inlineErrorCodes.includes("E_VERBNF") &&
          ref.inlineErrorFallbackText === "#-1"
      )
    );

    const unresolvedVerbCallFindings = await readJsonl(join(resolvedDir, "findings/unresolved_verb_calls.jsonl"));
    assert.equal(unresolvedVerbCallFindings.length, result.stats.unresolvedVerbCallCandidateCount + result.stats.unresolvedRootVerbFunctionCallCount);
    assert(unresolvedVerbCallFindings.every((finding) => finding.kind === "unresolved_verb_call" && finding.sourceVerbName === "test"));
    assert(
      unresolvedVerbCallFindings.some(
        (finding) =>
          finding.ref === "this:missing" &&
          finding.reason === "no_matching_direct_or_inherited_verb" &&
          finding.sourceLine === "this:missing();"
      )
    );
    assert(
      unresolvedVerbCallFindings.some(
        (finding) =>
          finding.ref === "this:optional_any" &&
          finding.reason === "no_matching_direct_or_inherited_verb" &&
          finding.inlineErrorHandled === true &&
          Array.isArray(finding.inlineErrorCodes) &&
          finding.inlineErrorCodes.includes("ANY") &&
          finding.sourceLine === "`this:optional_any() ! ANY';"
      )
    );
    assert(
      unresolvedVerbCallFindings.some(
        (finding) =>
          finding.ref === "$bf_max_object" &&
          finding.reason === "no_matching_direct_or_inherited_verb" &&
          finding.inlineErrorHandled === true &&
          Array.isArray(finding.inlineErrorCodes) &&
          finding.inlineErrorCodes.includes("E_VERBNF") &&
          finding.inlineErrorFallbackText === "#-1" &&
          finding.sourceLine === "maxobjhack = `$bf_max_object() ! E_VERBNF => #-1';"
      )
    );

    const report = await reportUnresolved({ resolvedDir });
    assert.equal(report.unresolvedVerbCallCount, result.stats.unresolvedVerbCallCandidateCount + result.stats.unresolvedRootVerbFunctionCallCount);
    assert.equal(report.unresolvedPropertyAccessCount, result.stats.unresolvedPropertyAccessCount);
    assert(report.byReason.some((group) => group.reason === "no_matching_direct_or_inherited_verb" && group.count === 7));
    assert(report.propertyByReason.some((group) => group.reason === "dynamic_property" && group.count === 2));
    assert(report.bySourceVerb.some((group) => group.sourceVerbName === "test" && group.count === 10));
    assert(report.propertyByReason.some((group) => group.reason === "destructured_variable_receiver" && group.count === 1));
    assert(!report.propertyByReason.some((group) => group.reason === "local_object_list_item_receiver"));
    assert(report.propertyByReason.some((group) => group.reason === "runtime_object_receiver" && group.count === 4));
    assert(report.propertyByReason.some((group) => group.reason === "runtime_object_function_receiver" && group.count === 2));
    assert(report.propertyByReason.some((group) => group.reason === "validated_runtime_object_receiver" && group.count === 6));
    assert(report.propertyByReason.some((group) => group.reason === "unbound_variable_receiver" && group.count === 7));
    assert(report.propertyBySourceVerb.some((group) => group.sourceVerbName === "test" && group.count === 28));
    assert(formatUnresolvedReport(report).includes("#20:test (#20:0) - 10"));
    assert(formatUnresolvedReport(report).includes("handled inline errors: ANY"));
    assert(formatUnresolvedReport(report).includes("Unresolved property accesses: 28"));

    const coverage = await reportCoverage({ resolvedDir });
    assert.equal(coverage.resolvedStats.staticVerbCallsiteCount, 54);
    assert.equal(coverage.resolvedStats.staticPropertyAccessCount, 56);
    assert.equal(coverage.definiteIssueCounts.verbCalls, 6);
    assert.equal(coverage.definiteIssueCounts.propertyAccesses, 2);
    assert.equal(coverage.resolutionRates.systemObjectRefCoverage, 32 / 38);
    assert.equal(coverage.resolutionRates.staticVerbCallsiteCoverage, 44 / 54);
    assert.equal(coverage.resolutionRates.staticPropertyAccessCoverage, 28 / 56);
    assert(formatCoverageReport(coverage).includes("static verb callsites: 81.5%"));

    const propertyEdges = await readJsonl(join(resolvedDir, "edges/property_candidate_edges.jsonl"));
    assert(propertyEdges.every((edge) => edge.sourceVerbName === "test"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "this" && edge.property === "foo" && edge.propertyId === "#20.foo" && edge.accessKind === "read"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "this" && edge.property === "foo" && edge.propertyId === "#20.foo" && edge.accessKind === "write"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "this" && edge.property === "inherited" && edge.propertyId === "#1.inherited" && edge.inheritanceDepth === 1));
    assert(propertyEdges.some((edge) => edge.receiverKind === "this" && edge.receiverRaw === "this" && edge.property === "test" && edge.propertyExpression === "verb" && edge.propertyId === "#20.test" && edge.resolutionKind === "this_verb_alias_property"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "this" && edge.receiverRaw === "this" && edge.property === "alias_test" && edge.propertyExpression === "verb" && edge.propertyId === "#1.alias_test" && edge.resolutionKind === "this_inherited_verb_alias_property"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "system_object" && edge.receiverRaw === "$string_utils" && edge.property === "coreprop" && edge.propertyId === "#30.coreprop"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "literal_object" && edge.receiverRaw === "#40" && edge.property === "shared" && edge.propertyId === "#30.shared" && edge.inheritanceDepth === 1 && JSON.stringify(edge.inheritancePath) === JSON.stringify(["#40", "#30"])));
    assert(propertyEdges.some((edge) => edge.receiverKind === "this" && edge.property === "name" && edge.propertyId === "builtin:name" && edge.resolutionKind === "built_in_property" && JSON.stringify(edge.inheritancePath) === JSON.stringify(["#20"])));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "local_this" && edge.receiverObject === "#20" && edge.property === "foo" && edge.propertyId === "#20.foo"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "local_obj" && edge.receiverObject === "#30" && edge.property === "location" && edge.propertyId === "builtin:location"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "local_location" && edge.receiverObject === "#40" && edge.property === "shared" && edge.propertyId === "#30.shared"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "local_obj" && edge.receiverObject === "#30" && edge.property === "contents" && edge.propertyId === "builtin:contents"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "item" && edge.receiverObject === "#40" && edge.property === "name" && edge.propertyId === "builtin:name"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "local_obj" && edge.receiverObject === "#30" && edge.property === "items" && edge.propertyId === "#30.items"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "list_item" && edge.receiverObject === "#40" && edge.property === "shared" && edge.propertyId === "#30.shared"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "ambiguous" && edge.receiverObject === "#40" && edge.property === "shared" && edge.propertyId === "#30.shared"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "branch_obj" && edge.receiverObject === "#30" && edge.property === "shared" && edge.propertyId === "#30.shared"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "branch_obj" && edge.receiverObject === "#40" && edge.property === "shared" && edge.propertyId === "#30.shared" && edge.inheritanceDepth === 1));
    assert(propertyEdges.some((edge) => edge.receiverKind === "property_access" && edge.receiverRaw === "local_obj.location" && edge.receiverObject === "#40" && edge.property === "owner" && edge.propertyId === "builtin:owner" && edge.resolutionKind === "chained_property_receiver"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "x" && edge.receiverObject === "#40" && edge.property === "interference_modifier" && edge.propertyId === "#40.interference_modifier"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "y" && edge.receiverObject === "#40" && edge.property === "interference_modifier" && edge.propertyId === "#40.interference_modifier"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "z" && edge.receiverObject === "#40" && edge.property === "interference_modifier" && edge.propertyId === "#40.interference_modifier"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "variable" && edge.receiverRaw === "guarded_player" && edge.receiverObject === "#40" && edge.property === "location" && edge.propertyId === "builtin:location"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "this" && edge.receiverRaw === "this" && edge.property === "foo" && edge.propertyId === "#20.foo"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "property_access" && edge.receiverRaw === "phone_holder.phone" && edge.receiverObject === "#40" && edge.property === "interference_modifier" && edge.propertyId === "#40.interference_modifier" && edge.resolutionKind === "chained_property_receiver"));
    assert(propertyEdges.some((edge) => edge.receiverKind === "literal_object" && edge.receiverRaw === "#0" && edge.propertyExpression === "root_prop" && edge.property === "root_status" && edge.propertyId === "#0.root_status" && edge.resolutionKind === "computed_properties_loop_property"));

    const guardedPropertyEdges = await readJsonl(join(resolvedDir, "edges/guarded_property_access_edges.jsonl"));
    assert.equal(guardedPropertyEdges.length, result.stats.guardedPropertyAccessCount);
    assert(
      guardedPropertyEdges.some(
        (edge) =>
          edge.kind === "guarded_property_access_edge" &&
          edge.ref === "this.namec" &&
          edge.receiverObject === "#20" &&
          edge.guardScope === "conditional_expression" &&
          edge.resolutionKind === "has_property_guarded_property" &&
          edge.confidence === "guarded"
      )
    );
    assert(guardedPropertyEdges.some((edge) => edge.ref === "runtime_hp.p" && edge.guardScope === "branch" && edge.guardText === "$ou:has_property(runtime_hp, \"p\")"));
    assert(guardedPropertyEdges.some((edge) => edge.ref === "exit_hp.p" && edge.guardScope === "post_continuation"));
    assert(guardedPropertyEdges.some((edge) => edge.ref === "phone_holder.phone" && edge.resolutionKind === "isa_guarded_property" && edge.guardText === "$ou:isa(phone_holder.phone, $freq_booster)"));
    assert(!guardedPropertyEdges.some((edge) => edge.ref === "this.foo"));
    assert(!guardedPropertyEdges.some((edge) => edge.ref === "dyn_hp.p"));
    assert(!guardedPropertyEdges.some((edge) => edge.ref === "mismatch_hp.q"));
    assert(!guardedPropertyEdges.some((edge) => edge.ref === "outside_hp.p"));

    const guardedVerbEdges = await readJsonl(join(resolvedDir, "edges/guarded_verb_call_edges.jsonl"));
    assert.equal(guardedVerbEdges.length, result.stats.guardedVerbCallCount);
    assert(guardedVerbEdges.some((edge) => edge.ref === "runtime_callable:boosted" && edge.guardScope === "branch" && edge.resolutionKind === "has_callable_verb_guarded_call"));
    assert(guardedVerbEdges.some((edge) => edge.ref === "runtime_cond:boosted" && edge.guardScope === "conditional_expression" && edge.resolutionKind === "has_verb_guarded_call"));
    assert(guardedVerbEdges.some((edge) => edge.ref === "exit_callable:boosted" && edge.guardScope === "post_continuation"));
    assert(!guardedVerbEdges.some((edge) => edge.ref === "local_obj:local"));
    assert(!guardedVerbEdges.some((edge) => edge.ref === "dynamic_callable:boosted"));
    assert(!guardedVerbEdges.some((edge) => edge.ref === "mismatch_callable:other"));
    assert(!guardedVerbEdges.some((edge) => edge.ref === "outside_callable:boosted"));

    const unresolvedPropertyFindings = await readJsonl(join(resolvedDir, "findings/unresolved_property_accesses.jsonl"));
    assert.equal(unresolvedPropertyFindings.length, result.stats.unresolvedPropertyAccessCount);
    assert(unresolvedPropertyFindings.every((finding) => finding.kind === "unresolved_property_access" && finding.sourceVerbName === "test"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "this.missing_prop" && finding.reason === "no_matching_property"));
    assert(
      unresolvedPropertyFindings.some(
        (finding) =>
          finding.ref === "this.missing_prop" &&
          finding.reason === "no_matching_property" &&
          finding.inlineErrorHandled === true &&
          Array.isArray(finding.inlineErrorCodes) &&
          finding.inlineErrorCodes.includes("E_PROPNF") &&
          finding.inlineErrorFallbackText === "0"
      )
    );
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "#999.foo" && finding.reason === "missing_object"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "player.name" && finding.reason === "player_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "dobj.name" && finding.reason === "runtime_object_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "match_branch.name" && finding.reason === "runtime_object_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "match_exit.owner" && finding.reason === "runtime_object_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "match_assigned.name" && finding.reason === "runtime_object_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "perms.wizard" && finding.reason === "runtime_object_function_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "caller_perms().programmer" && finding.reason === "runtime_object_function_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "valid_target.name" && finding.reason === "validated_runtime_object_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "valid_branch.name" && finding.reason === "validated_runtime_object_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "valid_exit.owner" && finding.reason === "validated_runtime_object_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "recycler_target.name" && finding.reason === "validated_runtime_object_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "recycler_branch.name" && finding.reason === "validated_runtime_object_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "recycler_exit.owner" && finding.reason === "validated_runtime_object_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "overwritten.name" && finding.reason === "argument_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "branch_unknown.name" && finding.reason === "argument_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "destructured_obj.name" && finding.reason === "destructured_variable_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "no_else.interference_modifier" && finding.reason === "unbound_variable_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "no_or.interference_modifier" && finding.reason === "unbound_variable_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "post_guard.interference_modifier" && finding.reason === "unbound_variable_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "dyn_hp.p" && finding.reason === "unbound_variable_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "mismatch_hp.q" && finding.reason === "unbound_variable_receiver"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "outside_hp.p" && finding.reason === "unbound_variable_receiver"));
    assert(!unresolvedPropertyFindings.some((finding) => finding.ref === "this.namec"));
    assert(!unresolvedPropertyFindings.some((finding) => finding.ref === "runtime_hp.p"));
    assert(!unresolvedPropertyFindings.some((finding) => finding.ref === "exit_hp.p"));
    assert(!unresolvedPropertyFindings.some((finding) => finding.ref === "x.interference_modifier"));
    assert(!unresolvedPropertyFindings.some((finding) => finding.ref === "y.interference_modifier"));
    assert(!unresolvedPropertyFindings.some((finding) => finding.ref === "z.interference_modifier"));
    assert(!unresolvedPropertyFindings.some((finding) => finding.ref === "guarded_player.location"));
    assert(!unresolvedPropertyFindings.some((finding) => finding.ref === "item.name"));
    assert(!unresolvedPropertyFindings.some((finding) => finding.ref === "this.(verb)"));
    assert(unresolvedPropertyFindings.some((finding) => finding.ref === "obj.(prop_name)" && finding.reason === "dynamic_property" && finding.accessKind === "write"));

    const localVariableStates = await readJsonl(join(resolvedDir, "flow/local_variable_states.jsonl"));
    assert.equal(localVariableStates.length, result.stats.localVariableStateCount);
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "perms" &&
          state.valueKind === "runtime_object" &&
          state.provenance === "known_runtime_object_function" &&
          state.reason === "runtime_object_function_receiver"
      )
    );
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "valid_branch" &&
          state.valueKind === "runtime_object" &&
          state.provenance === "valid_guard"
      )
    );
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "valid_exit" &&
          state.valueKind === "runtime_object" &&
          state.provenance === "valid_exit_guard"
      )
    );
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "recycler_branch" &&
          state.valueKind === "runtime_object" &&
          state.provenance === "valid_guard"
      )
    );
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "recycler_exit" &&
          state.valueKind === "runtime_object" &&
          state.provenance === "valid_exit_guard"
      )
    );
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "match_branch" &&
          state.valueKind === "runtime_object" &&
          state.provenance === "match_failure_guard" &&
          state.reason === "runtime_object_receiver"
      )
    );
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "match_exit" &&
          state.valueKind === "runtime_object" &&
          state.provenance === "match_failure_exit_guard" &&
          state.reason === "runtime_object_receiver"
      )
    );
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "match_assigned" &&
          state.valueKind === "runtime_object" &&
          state.provenance === "match_failure_exit_guard" &&
          state.reason === "runtime_object_receiver"
      )
    );
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "overwritten" &&
          state.valueKind === "runtime_object" &&
          state.provenance === "argument" &&
          state.reason === "argument_receiver"
      )
    );
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "x" &&
          state.provenance === "isa_guard" &&
          Array.isArray(state.objects) &&
          state.objects.includes("#40")
      )
    );
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "refined_item" &&
          state.provenance === "isa_guard" &&
          Array.isArray(state.objects) &&
          state.objects.length === 1 &&
          state.objects.includes("#40") &&
          !state.objects.includes("#30")
      )
    );
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "guarded_player" &&
          state.provenance === "isa_exit_guard" &&
          Array.isArray(state.objects) &&
          state.objects.includes("#40")
      )
    );
    assert(
      localVariableStates.some(
        (state) =>
          state.kind === "local_variable_state" &&
          state.variable === "branch_obj" &&
          state.valueKind === "object" &&
          state.controlFlowKind === "branch" &&
          Array.isArray(state.controlFlowPath)
      )
    );

    const inferredReceiverCandidates = await readJsonl(join(resolvedDir, "flow/inferred_receiver_candidates.jsonl"));
    assert.equal(inferredReceiverCandidates.length, result.stats.inferredReceiverCandidateCount);
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "perms" &&
          candidate.useKind === "property_access" &&
          candidate.provenance === "known_runtime_object_function" &&
          candidate.reason === "runtime_object_function_receiver"
      )
    );
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "valid_branch" &&
          candidate.useKind === "property_access" &&
          candidate.provenance === "valid_guard"
      )
    );
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "valid_exit" &&
          candidate.useKind === "property_access" &&
          candidate.provenance === "valid_exit_guard"
      )
    );
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "recycler_branch" &&
          candidate.useKind === "property_access" &&
          candidate.provenance === "valid_guard"
      )
    );
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "recycler_exit" &&
          candidate.useKind === "property_access" &&
          candidate.provenance === "valid_exit_guard"
      )
    );
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "match_branch" &&
          candidate.useKind === "property_access" &&
          candidate.provenance === "match_failure_guard" &&
          candidate.reason === "runtime_object_receiver"
      )
    );
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "match_exit" &&
          candidate.useKind === "property_access" &&
          candidate.provenance === "match_failure_exit_guard" &&
          candidate.reason === "runtime_object_receiver"
      )
    );
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "match_assigned" &&
          candidate.useKind === "property_access" &&
          candidate.provenance === "match_failure_exit_guard" &&
          candidate.reason === "runtime_object_receiver"
      )
    );
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "overwritten" &&
          candidate.useKind === "property_access" &&
          candidate.reason === "argument_receiver"
      )
    );
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "x" &&
          candidate.useKind === "property_access" &&
          candidate.provenance === "isa_guard" &&
          Array.isArray(candidate.objects) &&
          candidate.objects.includes("#40")
      )
    );
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "refined_item" &&
          candidate.useKind === "verb_call" &&
          candidate.provenance === "isa_guard" &&
          Array.isArray(candidate.objects) &&
          candidate.objects.length === 1 &&
          candidate.objects.includes("#40") &&
          !candidate.objects.includes("#30")
      )
    );
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "guarded_player" &&
          candidate.useKind === "property_access" &&
          candidate.provenance === "isa_exit_guard" &&
          Array.isArray(candidate.objects) &&
          candidate.objects.includes("#40")
      )
    );
    assert(
      inferredReceiverCandidates.some(
        (candidate) =>
          candidate.kind === "inferred_receiver_candidate" &&
          candidate.variable === "branch_obj" &&
          candidate.valueKind === "object_candidate_set" &&
          Array.isArray(candidate.objects) &&
          candidate.objects.includes("#30") &&
          candidate.objects.includes("#40")
      )
    );

    const receiverExplanation = await explainReceiver({
      resolvedDir,
      sourcePath: "verb_code/0000000020.0000.test.abc123.moo",
      line: 90
    });
    assert(receiverExplanation.inferredReceiverCandidates.some((candidate) => candidate.variable === "branch_obj"));
    assert.equal(receiverExplanation.propertyCandidateEdges.length, 2);
    assert(formatReceiverExplanation(receiverExplanation).includes("branch_obj.shared"));

    const callerQuery = await queryCallers({ resolvedDir, targetVerbId: "#30:1" });
    assert(callerQuery.callers.some((edge) => edge.kind === "verb_call_candidate_edge" && edge.receiverRaw === "#30" && edge.selector === "notify"));
    assert(
      callerQuery.callers.some((edge) => edge.kind === "verb_call_candidate_edge" && edge.receiverRaw === "local_obj" && edge.selector === "notify")
    );
    assert(formatCallerQuery(callerQuery).includes("Callers of #30:1"));

    const refQuery = await queryRefs({ resolvedDir, object: "#30" });
    assert(refQuery.literalObjectEdges.some((edge) => edge.object === "#30"));
    assert(refQuery.verbCallCandidateEdges.some((edge) => edge.targetVerbId === "#30:1"));
    assert(formatRefQuery(refQuery).includes("Refs to #30"));

    const symbolQuery = await queryRefs({ resolvedDir, symbol: "$string_utils" });
    assert(symbolQuery.systemObjectEdges.some((edge) => edge.symbol === "$String_Utils" && edge.targetObject === "#30"));
    const uppercaseSymbolQuery = await queryRefs({ resolvedDir, symbol: "$STRING_UTILS" });
    assert(uppercaseSymbolQuery.systemObjectEdges.some((edge) => edge.symbol === "$String_Utils" && edge.targetObject === "#30"));

    const sourceVerbQuery = await querySourceVerb({ resolvedDir, sourceVerbId: "#20:0" });
    assert.equal(sourceVerbQuery.sourceVerbName, "test");
    assert.equal(sourceVerbQuery.verbCallCandidateEdges.length, result.stats.resolvedVerbCallCandidateCount);
    assert(formatSourceVerbQuery(sourceVerbQuery).includes("Source verb: #20:test (#20:0)"));

    const unusedVerbs = await reportUnusedVerbs({ resolvedDir, extractDir: fixture, examplesPerBucket: 5 });
    assert.equal(unusedVerbs.targetVerbCount, 3);
    assert.equal(unusedVerbs.calledTargetVerbCount, 1);
    assert.equal(unusedVerbs.externallyReachableVerbCount, 1);
    assert.equal(unusedVerbs.unusedTargetVerbCount, 1);
    assert(unusedVerbs.buckets.some((bucket) => bucket.bucket === "no_static_callers" && bucket.count === 1));
    assert(unusedVerbs.buckets.some((bucket) => bucket.examples.some((finding) => finding.verbId === "#20:1" && finding.primaryName === "unused_helper")));
    assert(
      unusedVerbs.externalEntrypoints.examples.some(
        (finding) =>
          finding.verbId === "#0:1" &&
          finding.primaryName === "server_started" &&
          finding.bucket === "server_or_convention_entrypoint" &&
          finding.entrypointKind === "toaststunt_system_hook" &&
          finding.reachability.includes("external_entrypoint")
      )
    );
    assert(formatUnusedVerbsReport(unusedVerbs).includes("#20:1 #20:unused_helper"));
    assert(formatUnusedVerbsReport(unusedVerbs).includes("entrypoint=#0:server_started"));

    const executableUnusedVerbs = await reportUnusedVerbs({ resolvedDir, extractDir: fixture, requireExecute: true });
    assert.equal(executableUnusedVerbs.unusedTargetVerbCount, 1);

    const unprogrammedVerbs = await reportUnprogrammedVerbs({ resolvedDir, extractDir: fixture, examplesPerBucket: 5 });
    assert.equal(unprogrammedVerbs.unprogrammedVerbCount, 15);
    assert.equal(unprogrammedVerbs.programmedVerbCount, 3);
    assert(unprogrammedVerbs.buckets.some((bucket) => bucket.bucket === "non_executable_placeholder" && bucket.count === 15));
    assert(unprogrammedVerbs.buckets.some((bucket) => bucket.examples.some((finding) => finding.verbId === "#30:1" && finding.primaryName === "notify")));
    assert(formatUnprogrammedVerbsReport(unprogrammedVerbs).includes("#30:1 #30:notify"));

    const codeInsights = await reportCodeInsights({
      resolvedDir,
      examplesPerBucket: 5,
      minComplexity: 2,
      minLines: 1,
      minNesting: 1
    });
    assert.equal(codeInsights.totalMetricCount, 3);
    assert(codeInsights.buckets.some((bucket) => bucket.bucket === "high_complexity" && bucket.count > 0));
    assert(codeInsights.buckets.some((bucket) => bucket.examples.some((finding) => finding.sourceVerbId === "#20:0" && finding.ref.includes("#20:test"))));
    assert(formatCodeInsightsReport(codeInsights).includes("high_complexity"));

    const issuesReport = await reportIssues({ resolvedDir, examplesPerBucket: 2 });
    assert(issuesReport.domains.some((domain) => domain.domain === "moo_bug" && domain.count > 0));
    assert(issuesReport.domains.some((domain) => domain.domain === "handled_inline" && domain.count === 19));
    assert(issuesReport.domains.some((domain) => domain.domain === "graph_refinement" && domain.count > 0));
    assert(issuesReport.buckets.some((bucket) => bucket.bucket === "guarded_runtime_property" && bucket.count === 11));
    assert(issuesReport.buckets.some((bucket) => bucket.bucket === "guarded_runtime_verb" && bucket.count === 3));
    assert(issuesReport.buckets.some((bucket) => bucket.bucket === "runtime_universal_property" && bucket.count > 0));
    assert(formatIssuesReport(issuesReport).includes("missing_verb"));
    assert(formatIssuesReport(issuesReport).includes("invalid_property_reference"));
    assert(formatIssuesReport(issuesReport).includes("handled_inline_issue"));
    assert(formatIssuesReport(issuesReport).includes("guarded_runtime_property"));
    assert(formatIssuesReport(issuesReport).includes("guarded_runtime_verb"));

    const mooBugIssues = await reportIssues({ resolvedDir, domain: "moo_bug", examplesPerBucket: 2 });
    assert.equal(mooBugIssues.total, 12);
    assert.deepEqual(mooBugIssues.domains.map((domain) => domain.domain), ["moo_bug"]);
    assert(formatIssuesReport(mooBugIssues).includes("moo_bug: 12"));
    assert(!formatIssuesReport(mooBugIssues).includes("handled_inline:"));

    const guardedIssues = await reportIssues({ resolvedDir, bucket: "guarded_runtime_property", examplesPerBucket: 5 });
    assert.equal(guardedIssues.total, 11);
    assert.deepEqual(guardedIssues.domains.map((domain) => domain.domain), ["handled_inline"]);
    assert(guardedIssues.buckets.some((bucket) => bucket.bucket === "guarded_runtime_property" && bucket.count === 11));
    assert(guardedIssues.buckets.some((bucket) => bucket.byReason.some((reason) => reason.reason === "validated_runtime_object_receiver" && reason.count === 6)));
    assert(guardedIssues.buckets.some((bucket) => bucket.byReason.some((reason) => reason.reason === "isa_guarded_property" && reason.count === 2)));

    const guardedVerbIssues = await reportIssues({ resolvedDir, bucket: "guarded_runtime_verb", examplesPerBucket: 5 });
    assert.equal(guardedVerbIssues.total, 3);
    assert.deepEqual(guardedVerbIssues.domains.map((domain) => domain.domain), ["handled_inline"]);
    assert(guardedVerbIssues.buckets.some((bucket) => bucket.bucket === "guarded_runtime_verb" && bucket.count === 3));
    assert(guardedVerbIssues.buckets.some((bucket) => bucket.byReason.some((reason) => reason.reason === "has_callable_verb_guarded_call" && reason.count === 2)));

    const noMatchingPropertyIssues = await reportIssues({ resolvedDir, reason: "no_matching_property", examplesPerBucket: 5 });
    assert.equal(noMatchingPropertyIssues.total, 2);
    assert(noMatchingPropertyIssues.domains.some((domain) => domain.domain === "moo_bug" && domain.count === 1));
    assert(noMatchingPropertyIssues.domains.some((domain) => domain.domain === "handled_inline" && domain.count === 1));

    const verbContext = await contextForVerb({ resolvedDir, sourceVerbId: "#20:0" });
    assert.equal(verbContext.kind, "verb_context");
    assert.equal(verbContext.sourceVerb.sourceVerbName, "test");
    assert(verbContext.sourceSnippet?.lines.some((line) => line.text === "THIS:test();"));
    assert(formatVerbContext(verbContext).includes("Context for #20:test (#20:0)"));

    const issueContext = await contextForIssue({ resolvedDir, ref: "this:missing", contextLines: 1 });
    assert.equal(issueContext.kind, "issue_context");
    assert(issueContext.issues.some((issue) => issue.ref === "this:missing" && issue.reason === "no_matching_direct_or_inherited_verb"));
    assert(issueContext.sourceSnippets.some((snippet) => snippet.lines.some((line) => line.text === "this:missing();")));
    assert(formatIssueContext(issueContext).includes("Context for issue this:missing"));

    const webReport = await buildIssueWebReport({
      resolvedDir,
      contextLines: 1,
      examplesPerReason: 2,
      maxIssues: 200
    });
    assert.equal(webReport.contextLines, 1);
    assert(webReport.domains.some((domain) => domain.domain === "moo_bug" && domain.count > 0));
    assert(webReport.domains.some((domain) => domain.domain === "handled_inline" && domain.count === 19));
    assert(webReport.domains.some((domain) => domain.domain === "graph_refinement" && domain.count > 0));
    assert(webReport.domains.some((domain) => domain.domain === "unused_verbs" && domain.count === 1));
    assert(webReport.domains.some((domain) => domain.domain === "external_entrypoints" && domain.count === 1));
    assert(webReport.domains.some((domain) => domain.domain === "unprogrammed_verbs" && domain.count === 15));
    assert(webReport.domains.some((domain) => domain.domain === "code_insights"));
    assert(
      webReport.domains.some((domain) =>
        domain.domain === "unprogrammed_verbs" &&
        domain.buckets.some((bucket) =>
          bucket.bucket === "non_executable_placeholder" &&
          bucket.reasons.some((reason) =>
            reason.issues.some((issue) => issue.ref.includes("critical") && issue.refKind === "verb_definition" && issue.description.includes("no stored program body"))
          )
        )
      )
    );
    assert(
      webReport.domains.some((domain) =>
        domain.domain === "external_entrypoints" &&
        domain.buckets.some((bucket) =>
          bucket.bucket === "server_or_convention_entrypoint" &&
          bucket.reasons.some((reason) =>
            reason.issues.some(
              (issue) =>
                issue.ref.includes("server_started") &&
                issue.refKind === "verb_definition" &&
                issue.description.includes("src/server.cc")
            )
          )
        )
      )
    );
    assert(
      webReport.domains.some((domain) =>
        domain.domain === "unused_verbs" &&
        domain.buckets.some((bucket) =>
          bucket.bucket === "no_static_callers" &&
          bucket.reasons.some((reason) => reason.issues.some((issue) => issue.ref.includes("unused_helper") && issue.refKind === "verb_definition"))
        )
      )
    );
    assert(
      webReport.buckets.some((bucket) =>
        bucket.reasons.some((reason) =>
          reason.issues.some(
            (issue) =>
              issue.ref === "this:missing" &&
              issue.description.includes("no matching direct or inherited verb") &&
              issue.sourceSnippet?.lines.some((line) => line.text === "this:missing();" && line.highlight)
          )
        )
      )
    );
    assert(
      webReport.buckets.some((bucket) =>
        bucket.bucket === "handled_inline_issue" &&
        bucket.reasons.some((reason) =>
          reason.issues.some(
            (issue) =>
              issue.ref === "this:optional_any" &&
              issue.description.includes("protected by inline error handling") &&
              issue.inlineErrorCodes?.includes("ANY")
          )
        )
      )
    );

    const html = formatIssueWebReportHtml(webReport);
    assert(html.includes("MOO Code Graph Issues"));
    assert(html.includes("this:missing"));
    assert(html.includes("Handled Inline"));
    assert(html.includes("Dynamic Resolution"));
    assert(html.includes("data-search"));
    assert(!formatIssueWebReportHtml({ ...webReport, resolvedDir: "<script>alert(1)</script>" }).includes("<script>alert(1)</script>"));

    const served = await serveIssueWebReport({
      resolvedDir,
      host: "127.0.0.1",
      port: 0,
      contextLines: 1,
      examplesPerReason: 1,
      maxIssues: 10
    });
    try {
      const page = await fetch(served.url);
      assert.equal(page.status, 200);
      assert((page.headers.get("content-type") ?? "").includes("text/html"));
      assert((await page.text()).includes("MOO Code Graph Issues"));

      const jsonResponse = await fetch(new URL("/report.json", served.url));
      assert.equal(jsonResponse.status, 200);
      const json = (await jsonResponse.json()) as Record<string, unknown>;
      assert.equal(json.resolvedDir, resolvedDir);

      const health = await fetch(new URL("/healthz", served.url));
      assert.equal(health.status, 200);
      assert.equal(((await health.json()) as { ok?: boolean }).ok, true);

      const missing = await fetch(new URL("/missing", served.url));
      assert.equal(missing.status, 404);
    } finally {
      await served.close();
    }

    const reportsRoot = await mkdtemp(join(tmpdir(), "moo-code-graph-reports-"));
    const runDir = join(reportsRoot, "fixture", "20260612T000000Z");
    const reportDir = join(runDir, "report");
    try {
      const materialized = await materializeReportRun({
        dbName: "fixture",
        runId: "20260612T000000Z",
        runDir,
        reportDir,
        resolvedDir
      });
      assert(materialized.itemCount > 0);
      const storedSummary = await readReportSummary(reportsRoot, "fixture", "20260612T000000Z");
      assert(storedSummary.workspaces.some((workspace) => workspace.workspace === "code_bugs" && workspace.count > 0));
      assert(storedSummary.workspaces.some((workspace) => workspace.workspace === "handled_expected" && workspace.count > 0));
      assert(storedSummary.workspaces.some((workspace) => workspace.workspace === "dead_code" && workspace.count > 0));
      assert(storedSummary.workspaces.some((workspace) => workspace.workspace === "graph_refinement" && workspace.count > 0));
      assert(storedSummary.workspaces.some((workspace) => workspace.workspace === "code_insights"));

      const codeBugPage = await readReportItems(reportsRoot, "fixture", "20260612T000000Z", {
        workspace: "code_bugs",
        q: "this:missing",
        limit: 5
      });
      assert(codeBugPage.total > 0);
      assert(codeBugPage.items.some((item) => item.ref === "this:missing"));
      assert(codeBugPage.buckets.some((entry) => entry.count > 0));
      assert(codeBugPage.reasons.some((entry) => entry.reason === "no_matching_direct_or_inherited_verb"));

      await mkdir(reportsRoot, { recursive: true });
      await writeFile(
        join(reportsRoot, "index.json"),
        `${JSON.stringify({
          generatedAt: "2026-06-12T00:00:00.000Z",
          latest: { dbName: "fixture", runId: "20260612T000000Z" },
          databases: [
            {
              dbName: "fixture",
              latestRunId: "20260612T000000Z",
              runs: [{ runId: "20260612T000000Z", generatedAt: storedSummary.generatedAt, path: runDir, parseErrorCount: 0 }]
            }
          ]
        })}\n`,
        "utf8"
      );
      await writeFile(
        join(runDir, "manifest.json"),
        `${JSON.stringify({
          schemaVersion: "dynamic-report/v1",
          dbName: "fixture",
          runId: "20260612T000000Z",
          generatedAt: storedSummary.generatedAt,
          extractDir: fixture,
          graphDir,
          resolvedDir,
          reportDir,
          runDir,
          parseErrorCount: 0
        })}\n`,
        "utf8"
      );

      const app = createReportsApp({ reportsDir: reportsRoot, appDir: join(reportsRoot, "missing-app") });
      const dynamicServer = await new Promise<import("node:http").Server>((resolveServer, reject) => {
        const pending = app.listen(0, "127.0.0.1");
        pending.once("error", reject);
        pending.once("listening", () => resolveServer(pending));
      });
      try {
        const address = dynamicServer.address();
        assert(address && typeof address === "object");
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const catalogResponse = await fetch(`${baseUrl}/api/catalog`);
        assert.equal(catalogResponse.status, 200);
        assert.equal(((await catalogResponse.json()) as { latest?: { dbName?: string } }).latest?.dbName, "fixture");

        const summaryResponse = await fetch(`${baseUrl}/api/reports/fixture/20260612T000000Z/summary`);
        assert.equal(summaryResponse.status, 200);
        assert.equal(((await summaryResponse.json()) as { dbName?: string }).dbName, "fixture");

        const itemsResponse = await fetch(
          `${baseUrl}/api/reports/fixture/20260612T000000Z/items?workspace=code_bugs&q=this%3Amissing&limit=2`
        );
        assert.equal(itemsResponse.status, 200);
        const itemsJson = (await itemsResponse.json()) as { total: number; items: Array<{ ref: string }> };
        assert(itemsJson.total > 0);
        assert(itemsJson.items.some((item) => item.ref === "this:missing"));

        const graphSearchResponse = await fetch(`${baseUrl}/api/reports/fixture/20260612T000000Z/graph/search?q=notify`);
        assert.equal(graphSearchResponse.status, 200);
        const graphSearch = (await graphSearchResponse.json()) as { results: Array<{ id: string; kind: string; label: string }> };
        assert(graphSearch.results.some((result) => result.id === "verb:#30:1" && result.kind === "verb"));

        const sourceGraphResponse = await fetch(`${baseUrl}/api/reports/fixture/20260612T000000Z/graph/source-verb/%2320%3A0`);
        assert.equal(sourceGraphResponse.status, 200);
        const sourceGraph = (await sourceGraphResponse.json()) as { nodes: Array<{ id: string; kind: string }>; edges: Array<{ kind: string; target: string }> };
        assert(sourceGraph.nodes.some((node) => node.id === "verb:#20:0" && node.kind === "verb"));
        assert(sourceGraph.edges.some((edge) => edge.kind === "call" && edge.target === "verb:#30:1"));
        assert(sourceGraph.edges.some((edge) => edge.kind === "unresolved"));

        const neighborhoodResponse = await fetch(`${baseUrl}/api/reports/fixture/20260612T000000Z/graph/neighborhood?seed=verb%3A%2320%3A0&depth=1`);
        assert.equal(neighborhoodResponse.status, 200);
        const neighborhoodGraph = (await neighborhoodResponse.json()) as { seed: string; nodes: Array<{ id: string }> };
        assert.equal(neighborhoodGraph.seed, "verb:#20:0");
        assert(neighborhoodGraph.nodes.some((node) => node.id === "verb:#30:1"));

        const overviewResponse = await fetch(`${baseUrl}/api/reports/fixture/20260612T000000Z/graph/overview?mode=object`);
        assert.equal(overviewResponse.status, 200);
        const overviewGraph = (await overviewResponse.json()) as { nodes: Array<{ id: string; kind: string }>; edges: Array<{ kind: string }> };
        assert(overviewGraph.nodes.some((node) => node.id === "object:#20" && node.kind === "object"));
        assert(overviewGraph.edges.some((edge) => edge.kind === "inheritance"));
      } finally {
        await new Promise<void>((resolveClose, reject) => dynamicServer.close((error) => (error ? reject(error) : resolveClose())));
      }
    } finally {
      await rm(reportsRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(graphDir, { recursive: true, force: true });
    await rm(resolvedDir, { recursive: true, force: true });
  }
});

test("feature-list hook misses are classified as optional composition hooks", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "moo-code-graph-feature-hook-"));
  const extractDir = join(rootDir, "extract");
  const graphDir = join(rootDir, "graph");
  const resolvedDir = join(rootDir, "resolved");
  try {
    await mkdir(join(extractDir, "verb_code"), { recursive: true });
    await writeFile(join(extractDir, "manifest.json"), JSON.stringify({ snapshotId: "feature-hook-test" }, null, 2), "utf8");
    await writeJsonl(join(extractDir, "core_candidates.jsonl"), []);
    await writeJsonl(join(extractDir, "objects.jsonl"), [
      { kind: "object", objectId: 0, id: "#0", parents: ["#-1"], children: ["#74", "#88"], recycled: false },
      { kind: "object", objectId: 74, id: "#74", parents: ["#0"], children: ["#89", "#90"], recycled: false },
      { kind: "object", objectId: 88, id: "#88", parents: ["#0"], children: [], recycled: false },
      { kind: "object", objectId: 89, id: "#89", parents: ["#74"], children: [], recycled: false },
      { kind: "object", objectId: 90, id: "#90", parents: ["#74"], children: [], recycled: false }
    ]);
    await writeJsonl(join(extractDir, "properties.jsonl"), [
      { kind: "property_definition", id: "#88.features", objectId: 88, object: "#88", name: "features", definitionIndex: 0 }
    ]);
    await writeJsonl(join(extractDir, "property_values.jsonl"), [
      {
        kind: "property_value",
        objectId: 88,
        object: "#88",
        propertyIndex: 0,
        name: "features",
        value: { type: "list", objectRefs: ["#90", "#89"], truncated: false, redacted: false }
      }
    ]);
    await writeJsonl(join(extractDir, "verbs.jsonl"), [
      {
        kind: "verb",
        id: "#74:0",
        objectId: 74,
        object: "#74",
        verbIndex: 0,
        names: ["player_connected"],
        primaryName: "player_connected",
        hasProgram: false
      },
      {
        kind: "verb",
        id: "#88:0",
        objectId: 88,
        object: "#88",
        verbIndex: 0,
        names: ["disfunc"],
        primaryName: "disfunc",
        hasProgram: true,
        sourcePath: "verb_code/0000000088.0000.disfunc.test.moo",
        permissionsRaw: 173,
        permissions: ["read", "write", "execute", "iobj"],
        prepositionsRaw: -1,
        prepositions: ["none"]
      },
      {
        kind: "verb",
        id: "#90:0",
        objectId: 90,
        object: "#90",
        verbIndex: 0,
        names: ["@paste"],
        primaryName: "@paste",
        hasProgram: true,
        sourcePath: "verb_code/0000000090.0000.paste.test.moo",
        permissionsRaw: 173,
        permissions: ["read", "write", "execute", "iobj"],
        prepositionsRaw: -1,
        prepositions: ["none"]
      }
    ]);
    await writeFile(
      join(extractDir, "verb_code/0000000088.0000.disfunc.test.moo"),
      [
        "\"Notify feature objects that the player has disconnected.\";",
        "for feature in (this.features)",
        "try",
        "feature:player_disconnected(player, @args);",
        "except (ANY)",
        "continue feature;",
        "endtry",
        "endfor",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(extractDir, "verb_code/0000000090.0000.paste.test.moo"),
      ["for thing in (player.location.contents)", "thing:tell_lines(to_tell);", "endfor", ""].join("\n"),
      "utf8"
    );

    await indexMooCodeGraph({ extractDir, outputDir: graphDir, overwrite: true });
    await resolveMooCodeGraph({ extractDir, graphDir, outputDir: resolvedDir, overwrite: true });

    const unresolvedVerbCalls = await readJsonl(join(resolvedDir, "findings/unresolved_verb_calls.jsonl"));
    const hookFinding = unresolvedVerbCalls.find((finding) => finding.ref === "feature:player_disconnected");
    assert(hookFinding);
    assert.equal(hookFinding.reason, "no_matching_content_item_candidate");
    assert.deepEqual(hookFinding.candidateObjects, ["#90", "#89"]);
    assert.equal(hookFinding.compositionKind, "feature_list_hook");
    assert.equal(hookFinding.optionalHookHandled, true);

    const issuesReport = await reportIssues({ resolvedDir, examplesPerBucket: 5 });
    assert(issuesReport.domains.some((domain) => domain.domain === "handled_inline" && domain.count === 1));
    assert(issuesReport.buckets.some((bucket) => bucket.bucket === "optional_composition_hook" && bucket.count === 1));
    assert(!issuesReport.buckets.some((bucket) => bucket.bucket === "candidate_miss" && bucket.count > 0));
    assert(formatIssuesReport(issuesReport).includes("optional_composition_hook"));

    const unresolvedProperties = await readJsonl(join(resolvedDir, "findings/unresolved_property_accesses.jsonl"));
    const runtimeChain = unresolvedProperties.find((finding) => finding.ref === "player.location.contents");
    assert(runtimeChain);
    assert.equal(runtimeChain.reason, "runtime_property_chain_receiver");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("syntax-rich fixture emits exact raw facts for ToastCore-derived cases", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "moo-code-graph-rich-"));
  await rm(outputDir, { recursive: true, force: true });
  try {
    const result = await indexMooCodeGraph({ extractDir: syntaxRichFixture, outputDir, overwrite: true });
    assert.equal(result.stats.parseErrorCount, 0);

    const assignments = await readJsonl(join(outputDir, "code_facts/assignments.jsonl"));
    assert(assignments.some((fact) => fact.leftText === "pass" && fact.rightText === "args[2]"));
    assert(assignments.some((fact) => fact.leftText === "$quota_utils" && fact.rightText === "this"));
    assert(assignments.some((fact) => fact.leftText === "value" && fact.rightText === "top ? value / 1e+24 | (value * 1e+24)"));
    assert(assignments.some((fact) => fact.leftText === "ret" && fact.rightText === "((red << 5) |. (green << 2)) |. blue"));
    assert(assignments.some((fact) => fact.assignmentKind === "expression" && fact.leftText === "cp" && fact.rightText === "caller_perms()"));

    const systemObjectRefs = await readJsonl(join(outputDir, "code_facts/system_object_refs.jsonl"));
    assert(systemObjectRefs.some((fact) => fact.symbol === "$quota_utils" && fact.context === "assignment_left"));
    assert(systemObjectRefs.some((fact) => fact.symbol === "$sin" && fact.context === "expression"));

    const functionCalls = await readJsonl(join(outputDir, "code_facts/function_calls.jsonl"));
    assert(functionCalls.some((fact) => fact.function === "$sin" && fact.argumentsText === "(0)"));
    assert(functionCalls.some((fact) => fact.function === "valid"));
    assert(functionCalls.some((fact) => fact.function === "caller_perms"));

    const callsites = await readJsonl(join(outputDir, "code_facts/callsites.jsonl"));
    assert(callsites.some((fact) => fact.receiverRaw === "fobj" && fact.selectorKind === "dynamic" && fact.selectorExpression === "fverb" && fact.argumentsText === "(@pass)"));
    assert(callsites.some((fact) => fact.receiverKind === "this" && fact.selector === "do_reset"));

    const objectRefs = await readJsonl(join(outputDir, "code_facts/object_refs.jsonl"));
    assert(objectRefs.some((fact) => fact.object === "#-1"));

    const parseErrors = await readJsonl(join(outputDir, "code_facts/parse_errors.jsonl"));
    assert.equal(parseErrors.length, 0);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("code insights ignore MOO builtin context variables for argument-heavy checks", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "moo-code-graph-code-insights-"));
  const graphDir = join(rootDir, "graph");
  const resolvedDir = join(rootDir, "resolved");
  const factsDir = join(graphDir, "code_facts");
  try {
    await mkdir(factsDir, { recursive: true });
    await mkdir(resolvedDir, { recursive: true });
    await writeFile(
      join(resolvedDir, "manifest.json"),
      `${JSON.stringify({
        tool: "moo-code-graph",
        mode: "resolved-reference-edges",
        sourceGraphDir: graphDir,
        sourceExtractDir: rootDir,
        sourceSnapshotId: "argument-heavy-fixture"
      })}\n`,
      "utf8"
    );
    await writeJsonl(join(factsDir, "verb_metrics.jsonl"), [
      {
        kind: "verb_metric",
        sourceVerbId: "#3:12",
        sourceObject: "#3",
        sourcePath: "verb_code/look.moo",
        lineCount: 4,
        nonBlankLineCount: 4,
        statementCount: 4,
        branchCount: 0,
        loopCount: 0,
        conditionalExpressionCount: 0,
        logicalOperatorCount: 0,
        tryCount: 0,
        inlineErrorCount: 0,
        maxControlFlowDepth: 3,
        cyclomaticComplexity: 1
      }
    ]);
    await writeJsonl(
      join(factsDir, "identifier_refs.jsonl"),
      [
        ...["dobjstr", "prepstr", "iobjstr", "iobj", "args", "argstr", "player", "this"].flatMap((name, nameIndex) =>
          Array.from({ length: 4 }, (_, refIndex) => ({
            kind: "identifier_ref",
            sourceVerbId: "#3:12",
            sourceObject: "#3",
            sourcePath: "verb_code/look.moo",
            line: nameIndex,
            column: refIndex,
            name,
            refContext: "read"
          }))
        ),
        {
          kind: "identifier_ref",
          sourceVerbId: "#3:12",
          sourceObject: "#3",
          sourcePath: "verb_code/look.moo",
          line: 12,
          column: 15,
          name: "saved",
          refContext: "read"
        },
        {
          kind: "identifier_ref",
          sourceVerbId: "#3:12",
          sourceObject: "#3",
          sourcePath: "verb_code/look.moo",
          line: 60,
          column: 8,
          name: "deep_value",
          refContext: "read",
          controlFlowDepth: 3
        }
      ]
    );
    await writeJsonl(
      join(factsDir, "assignments.jsonl"),
      [
        {
          kind: "assignment",
          sourceVerbId: "#3:12",
          sourceObject: "#3",
          sourcePath: "verb_code/look.moo",
          line: 10,
          column: 0,
          assignmentKind: "statement",
          leftText: "saved",
          rightText: "{}"
        },
        {
          kind: "assignment",
          sourceVerbId: "#3:12",
          sourceObject: "#3",
          sourcePath: "verb_code/look.moo",
          line: 12,
          column: 0,
          assignmentKind: "statement",
          leftText: "saved",
          rightText: "setadd(saved, v)"
        },
        {
          kind: "assignment",
          sourceVerbId: "#3:12",
          sourceObject: "#3",
          sourcePath: "verb_code/look.moo",
          line: 20,
          column: 0,
          assignmentKind: "statement",
          leftText: "clobbered",
          rightText: "1"
        },
        {
          kind: "assignment",
          sourceVerbId: "#3:12",
          sourceObject: "#3",
          sourcePath: "verb_code/look.moo",
          line: 21,
          column: 0,
          assignmentKind: "statement",
          leftText: "clobbered",
          rightText: "2"
        },
        {
          kind: "assignment",
          sourceVerbId: "#3:12",
          sourceObject: "#3",
          sourcePath: "verb_code/look.moo",
          line: 30,
          column: 0,
          controlFlowPath: ["if_statement@29:0-33:5"],
          assignmentKind: "statement",
          leftText: "branch_value",
          rightText: "\"yes\""
        },
        {
          kind: "assignment",
          sourceVerbId: "#3:12",
          sourceObject: "#3",
          sourcePath: "verb_code/look.moo",
          line: 32,
          column: 0,
          controlFlowPath: ["if_statement@29:0-33:5", "else_clause@31:0-32:18"],
          assignmentKind: "statement",
          leftText: "branch_value",
          rightText: "\"no\""
        },
        {
          kind: "assignment",
          sourceVerbId: "#3:12",
          sourceObject: "#3",
          sourcePath: "verb_code/look.moo",
          line: 40,
          column: 0,
          assignmentKind: "statement",
          leftText: "changed",
          rightText: "0"
        },
        {
          kind: "assignment",
          sourceVerbId: "#3:12",
          sourceObject: "#3",
          sourcePath: "verb_code/look.moo",
          line: 43,
          column: 0,
          controlFlowPath: ["for_statement@41:0-44:6", "if_statement@42:0-43:11"],
          assignmentKind: "statement",
          leftText: "changed",
          rightText: "1"
        },
        {
          kind: "assignment",
          sourceVerbId: "#3:12",
          sourceObject: "#3",
          sourcePath: "verb_code/look.moo",
          line: 50,
          column: 4,
          controlFlowPath: ["while_statement@49:0-53:8", "if_statement@50:0-52:5"],
          assignmentKind: "expression",
          leftText: "nospace",
          rightText: "cutoff < len"
        },
        {
          kind: "assignment",
          sourceVerbId: "#3:12",
          sourceObject: "#3",
          sourcePath: "verb_code/look.moo",
          line: 51,
          column: 0,
          controlFlowPath: ["while_statement@49:0-53:8", "if_statement@50:0-52:5"],
          assignmentKind: "statement",
          leftText: "nospace",
          rightText: "line[cutoff] != \" \""
        }
      ]
    );

    const report = await reportCodeInsights({ resolvedDir });
    assert.equal(report.buckets.find((bucket) => bucket.bucket === "argument_heavy")?.count, 0);
    const deadStoreExamples = report.buckets.find((bucket) => bucket.bucket === "dead_store")?.examples ?? [];
    assert(!deadStoreExamples.some((finding) => finding.variableName === "saved"));
    assert(!deadStoreExamples.some((finding) => finding.variableName === "branch_value"));
    assert(!deadStoreExamples.some((finding) => finding.variableName === "changed"));
    assert(!deadStoreExamples.some((finding) => finding.variableName === "nospace"));
    assert(deadStoreExamples.some((finding) => finding.variableName === "clobbered"));

    const customThresholdReport = await reportCodeInsights({
      resolvedDir,
      config: {
        ...defaultReportConfig.reports.codeInsights,
        minNesting: 3
      }
    });
    assert.equal(customThresholdReport.buckets.find((bucket) => bucket.bucket === "deep_nesting")?.count, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("code insights can suppress unused destructuring bindings when sibling bindings are used", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "moo-code-graph-destructuring-insights-"));
  const graphDir = join(rootDir, "graph");
  const factsDir = join(graphDir, "code_facts");
  const resolvedDir = join(rootDir, "resolved");
  try {
    await mkdir(factsDir, { recursive: true });
    await mkdir(resolvedDir, { recursive: true });
    await writeFile(
      join(resolvedDir, "manifest.json"),
      `${JSON.stringify({
        tool: "moo-code-graph",
        mode: "resolved-reference-edges",
        sourceGraphDir: graphDir,
        sourceSnapshotId: "destructuring-insights-fixture"
      })}\n`,
      "utf8"
    );
    await writeJsonl(join(factsDir, "identifier_refs.jsonl"), [
      {
        kind: "identifier_ref",
        sourceVerbId: "#3:12",
        sourceObject: "#3",
        sourcePath: "verb_code/look.moo",
        line: 2,
        column: 12,
        name: "msg",
        refContext: "read"
      }
    ]);
    await writeJsonl(join(factsDir, "destructuring_bindings.jsonl"), [
      {
        kind: "destructuring_binding",
        sourceVerbId: "#3:12",
        sourceObject: "#3",
        sourcePath: "verb_code/look.moo",
        line: 1,
        column: 0,
        variable: "msg",
        patternText: "{msg, error}",
        rightText: "args"
      },
      {
        kind: "destructuring_binding",
        sourceVerbId: "#3:12",
        sourceObject: "#3",
        sourcePath: "verb_code/look.moo",
        line: 1,
        column: 0,
        variable: "error",
        patternText: "{msg, error}",
        rightText: "args"
      },
      {
        kind: "destructuring_binding",
        sourceVerbId: "#3:12",
        sourceObject: "#3",
        sourcePath: "verb_code/look.moo",
        line: 5,
        column: 0,
        variable: "unused_a",
        patternText: "{unused_a, unused_b}",
        rightText: "other"
      },
      {
        kind: "destructuring_binding",
        sourceVerbId: "#3:12",
        sourceObject: "#3",
        sourcePath: "verb_code/look.moo",
        line: 5,
        column: 0,
        variable: "unused_b",
        patternText: "{unused_a, unused_b}",
        rightText: "other"
      }
    ]);

    const defaultReport = await reportCodeInsights({ resolvedDir });
    const defaultExamples = defaultReport.buckets.find((bucket) => bucket.bucket === "unused_destructuring_binding")?.examples ?? [];
    assert.deepEqual(
      defaultExamples.map((finding) => finding.variableName).sort(),
      ["unused_a", "unused_b"]
    );

    const includePartialReport = await reportCodeInsights({
      resolvedDir,
      config: {
        ...defaultReportConfig.reports.codeInsights,
        includeUnusedDestructuringArgsWhenOtherArgsAreUsed: true
      }
    });
    const includePartialExamples = includePartialReport.buckets.find((bucket) => bucket.bucket === "unused_destructuring_binding")?.examples ?? [];
    assert.deepEqual(
      includePartialExamples.map((finding) => finding.variableName).sort(),
      ["error", "unused_a", "unused_b"]
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeJsonl(path: string, rows: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function assignment(sourceVerbId: string, sourceObject: string, sourcePath: string, line: number, leftText: string, rightText: string): Record<string, unknown> {
  return {
    kind: "assignment",
    assignmentKind: "statement",
    sourceVerbId,
    sourceObject,
    sourcePath,
    line,
    column: 0,
    leftText,
    rightText
  };
}

function propertyWrite(sourceVerbId: string, sourceObject: string, sourcePath: string, line: number, property: string, propertyId: string): Record<string, unknown> {
  return {
    kind: "property_candidate_edge",
    sourceVerbId,
    sourceVerbName: "mutate",
    sourceObject,
    sourcePath,
    line,
    column: 0,
    accessKind: "write",
    receiverKind: "this",
    receiverRaw: "this",
    receiverObject: sourceObject,
    property,
    targetObject: sourceObject,
    definedOn: sourceObject,
    inheritanceDepth: 0,
    inheritancePath: [sourceObject],
    propertyId,
    resolutionKind: "this_static_property",
    confidence: "candidate"
  };
}
