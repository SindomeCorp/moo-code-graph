# moo-code-graph

`@sindomecorp/moo-code-graph` is the first-pass orchestration and raw code-fact extraction layer for the MOO graph pipeline.

It consumes normalized output from `@sindomecorp/toaststunt-db-extractor`, parses generated `verb_code/*.moo` files with `tree-sitter-moo`, and emits raw syntax facts as JSONL.

This repo vendors `tree-sitter@0.25.0` with a build-only C++20 setting so plain `npm install` works under Node 24 while keeping the runtime API aligned with `tree-sitter-moo`.

The indexer emits raw syntax facts. The optional resolver emits conservative candidate edges for receiver identities that are known from syntax or extractor metadata.

## From Zero to Web Report

This repository is intended to run from source. It is not currently released as an npm package.

Prerequisites:

- Node.js 22 or newer
- npm
- A local ToastStunt checkpoint database file

Clone, install, and build:

```bash
git clone https://github.com/SindomeCorp/moo-code-graph.git
cd moo-code-graph
npm install
npm run build
```

Generate a persistent report from a database of your choice:

```bash
node dist/cli.js run-report /path/to/toaststunt.db --db-name my-db --reports-dir ./reports
```

Start the dynamic report app:

```bash
node dist/cli.js serve reports ./reports --host 127.0.0.1 --port 8787
```

Open `http://127.0.0.1:8787`. The app defaults to the latest generated report and exposes `Code Bugs`, `Code Improvements`, `Mutation / Invariants`, `Dead Code`, `Handled / Expected`, and `Dynamic Resolution` workspaces.

The report pipeline performs extraction, raw fact indexing, conservative resolution, and report materialization in one command. The lower-level `validate`, `index`, `resolve`, `report`, `query`, and `context` commands remain available for debugging or scripting.

### Troubleshooting

- Use an absolute DB path if `run-report` cannot find the checkpoint file.
- Confirm `node --version` reports v22 or newer.
- If native `tree-sitter` install fails, retry from a clean install with `rm -rf node_modules package-lock.json && npm install`.
- If port `8787` is already in use, pass another `--port`.
- Reports can include source snippets and DB-derived metadata. Keep generated `reports/` directories local unless you have reviewed them for sensitive data.

## Pipeline Position

```text
@sindomecorp/toaststunt-db-extractor
  ToastStunt checkpoint DB -> normalized extractor output + verb_code/*.moo

tree-sitter-moo
  raw MOO verb body -> syntax AST

extract/latest/
  -> moo-code-graph
  -> raw code facts
```

This package does not implement SQLite, Neo4j, MCP, Codex context generation, impact analysis, security reports, runtime trace ingestion, AI-based parsing, or `tree-sitter-graph`.

## Input

Expected extractor output:

```text
extract/latest/
  manifest.json
  objects.jsonl
  verbs.jsonl
  properties.jsonl
  property_values.jsonl
  core_candidates.jsonl
  verb_code/
    0000000020.0000.test.abc123.moo
```

The indexer maps each programmed verb's `sourcePath` from `verbs.jsonl` back to its source verb id, source object, and source path. Every emitted fact includes that metadata.

The extractor output schema is imported from `@sindomecorp/toaststunt-db-extractor`. This package should not duplicate extractor schemas unless an upstream type is missing.

## Output

```text
graph/latest/
  manifest.json
  code_facts/
    callsites.jsonl
    function_calls.jsonl
    object_refs.jsonl
    system_object_refs.jsonl
    property_accesses.jsonl
    assignments.jsonl
    local_bindings.jsonl
    destructuring_bindings.jsonl
    loop_bindings.jsonl
    comments.jsonl
    parse_errors.jsonl
    stats.json
```

Line and column positions are zero-based, matching Tree-sitter positions.

## CLI

```bash
moo-code-graph validate ./extract/latest
moo-code-graph inspect ./extract/latest
moo-code-graph index ./extract/latest --out ./graph/latest --overwrite
moo-code-graph resolve ./graph/latest --extract ./extract/latest --out ./resolved/latest --overwrite
moo-code-graph report unresolved ./resolved/latest --top 25 --examples 10
moo-code-graph report coverage ./resolved/latest
moo-code-graph report issues ./resolved/latest
moo-code-graph report mutation-invariants ./resolved/latest
moo-code-graph report unused-verbs ./resolved/latest
moo-code-graph report unprogrammed-verbs ./resolved/latest
moo-code-graph run-report ./toastcore.db --db-name toastcore
moo-code-graph serve reports ./reports
moo-code-graph serve report ./resolved/latest
moo-code-graph explain receiver ./resolved/latest --source verb_code/0000000020.0000.test.abc123.moo --line 12
moo-code-graph query callers ./resolved/latest --target-verb '#30:1'
moo-code-graph query refs ./resolved/latest --object '#30'
moo-code-graph query refs ./resolved/latest --symbol '$string_utils'
moo-code-graph query source-verb ./resolved/latest '#20:0'
moo-code-graph context verb ./resolved/latest '#20:0'
moo-code-graph context issue ./resolved/latest --ref 'this:missing'
```

Resolved outputs include root-object edges for `$name` syntax:

```text
resolved/latest/
  edges/
    root_property_edges.jsonl
    root_verb_call_edges.jsonl
```

`root_property_edges.jsonl` records `$property` references that match a property defined on `#0`, such as `$last_restart_time`.
`root_verb_call_edges.jsonl` records `$verb(...)` calls that match a verb defined on `#0`, such as `$critical(...)`.
These are resolved separately from core object candidates because `$name` can mean a root property/verb even when it is not an object-valued core candidate.

Index options:

```text
--out <dir>   Required output directory
--overwrite   Allow replacing output dir
--pretty      Pretty-print JSON where applicable
--quiet       Suppress progress logs
```

## ToastCore Regression

Run the real ToastCore pipeline locally:

```bash
npm run scaffold-toastcore
```

This clones or updates `https://github.com/lisdude/toastcore/` into `tmp/toastcore`, extracts `toastcore.db` into `tmp/extract-toastcore`, indexes raw code facts into `tmp/graph-toastcore`, and fails if any Tree-sitter parse errors are emitted.

Useful variants:

```bash
npm run scaffold-toastcore -- --refresh
TOASTCORE_REF=<branch-or-tag> npm run scaffold-toastcore
npm run test:toastcore
```

For real ToastStunt DB extracts, `parseErrorCount` must be `0`. DB-stored MOO code has already been accepted by ToastStunt, so rows in `graph/code_facts/parse_errors.jsonl` should be treated as likely `tree-sitter-moo` grammar gaps unless there is clear evidence that extraction corrupted the source. Release reports must surface each parse-error row with `sourceVerbId`, `sourcePath`, `line`, `column`, and a short source-line sample when practical.

If parse errors remain, inspect `~/tree-sitter-moo` and add the syntax as a grammar regression fixture before considering the real-data validation complete.

## Release Verification

Before tagging a GitHub source release, run:

```bash
npm install
npm run typecheck
npm run dev:test
npm run build
npm test
npm audit --omit=dev
npm run test:toastcore -- --refresh
npm run audit:graph -- ./tmp/graph-toastcore
node dist/cli.js resolve ./tmp/graph-toastcore --extract ./tmp/extract-toastcore --out ./tmp/resolved-toastcore --overwrite --quiet
npm run audit:resolved -- ./tmp/resolved-toastcore
npm run check:toastcore-unresolved -- ./tmp/resolved-toastcore
npm run check:toastcore-unresolved-properties -- ./tmp/resolved-toastcore
npm run check:toastcore-coverage -- ./tmp/resolved-toastcore
```

Then smoke-test the generated web app:

```bash
node dist/cli.js run-report ./tmp/toastcore/toastcore.db --db-name toastcore-smoke --reports-dir ./tmp/reports-smoke --overwrite
node dist/cli.js serve reports ./tmp/reports-smoke --host 127.0.0.1 --port 8787
```

Open `http://127.0.0.1:8787` and verify the latest report loads, each workspace tab renders, and search/filter controls work. The current Vite production build emits a large-bundle warning for the web UI; this is accepted for v1 unless a release owner decides to code-split before tagging.

## Fact Audit

Audit a generated graph directory for schema-shape invariants and stats consistency:

```bash
npm run audit:graph -- ./tmp/graph-toastcore
npm run audit:resolved -- ./tmp/resolved-toastcore
npm run analyze:unresolved -- ./tmp/resolved-toastcore
npm run check:toastcore-unresolved -- ./tmp/resolved-toastcore
npm run check:toastcore-unresolved-properties -- ./tmp/resolved-toastcore
npm run check:toastcore-coverage -- ./tmp/resolved-toastcore
node dist/cli.js report unresolved ./tmp/resolved-toastcore --top 25 --examples 10
node dist/cli.js report coverage ./tmp/resolved-toastcore
node dist/cli.js report issues ./tmp/resolved-toastcore
node dist/cli.js report unused-verbs ./tmp/resolved-toastcore --require-execute
node dist/cli.js run-report ./tmp/toastcore/toastcore.db --db-name toastcore --reports-dir ./reports
node dist/cli.js serve reports ./reports --host 0.0.0.0 --port 8787
node dist/cli.js serve report ./tmp/resolved-toastcore --host 0.0.0.0 --port 8787
```

These checks validate shape, stats consistency, resolved edge targets against extractor objects/verbs/properties, and the ToastCore unresolved/coverage snapshots.

`analyze:unresolved` groups unresolved refs by reason, `$symbol`, receiver object, selector, source verb, and representative source locations. Use it to decide which resolver phase should come next.

`check:toastcore-unresolved` compares `findings/unresolved_verb_calls.jsonl` against the checked-in ToastCore snapshot. Known unresolved ToastCore calls stay unresolved: this is how the pipeline surfaces syntactically valid code that calls missing verbs or undefined `$core` symbols.

`check:toastcore-unresolved-properties` compares ToastCore unresolved property-access counts by reason. It intentionally snapshots only summary counts because many property receivers are runtime values even after local flow analysis.

`check:toastcore-coverage` snapshots raw fact counts, resolved edge counts, unresolved reason counts, and definite issue counts for ToastCore. Use `moo-code-graph report coverage` to inspect current coverage rates for system object refs, literal object refs, static verb callsites, and static property accesses.

## Query CLI

The query layer reads an existing `resolved/` directory and does not modify graph output.

```bash
moo-code-graph explain receiver ./resolved/latest --source verb_code/0000000020.0000.test.abc123.moo --line 51
moo-code-graph explain unresolved ./resolved/latest --top 10 --examples 5
moo-code-graph report issues ./resolved/latest --examples 5
moo-code-graph report issues ./resolved/latest --domain moo_bug --examples 5
moo-code-graph report issues ./resolved/latest --bucket guarded_runtime_property --json
moo-code-graph report issues ./resolved/latest --bucket guarded_runtime_verb --json
moo-code-graph report unused-verbs ./resolved/latest --examples 25
moo-code-graph report unused-verbs ./resolved/latest --require-execute --json
moo-code-graph report unprogrammed-verbs ./resolved/latest --examples 25
moo-code-graph query callers ./resolved/latest --target-verb '#30:1'
moo-code-graph query refs ./resolved/latest --object '#30'
moo-code-graph query refs ./resolved/latest --symbol '$string_utils'
moo-code-graph query source-verb ./resolved/latest '#20:0'
moo-code-graph context verb ./resolved/latest '#20:0'
moo-code-graph context issue ./resolved/latest --ref 'this:missing' --context-lines 3
```

All query commands support `--json` for scripts and LLM/IDE integrations.

`report issues` triages unresolved and refinement rows into three views: `moo_bug`, `handled_inline`, and Dynamic Resolution (`graph_refinement` in JSON/CLI filters). `moo_bug` is intentionally strict and contains high-confidence code/data problems, split into buckets such as `missing_core_reference`, `missing_core_target_object`, `missing_object`, `missing_verb`, and `invalid_property_reference`. `handled_inline` covers unresolved verb calls protected by MOO inline error handling such as `` `this:maybe_hook() ! E_VERBNF' `` or `` `this:maybe_hook() ! ANY => 0' ``, optional feature-list composition hooks protected by `try`/`except`, unresolved property accesses protected by `E_PROPNF` or `ANY`, and property accesses validated by local `has_property` predicate guards but not backed by static extracted property metadata. Dynamic Resolution contains runtime-dependent receivers, model gaps, candidate misses, and runtime accesses to universal object properties such as `papa.f`. These rows are separated from likely MOO defects. `context verb` and `context issue` create compact bundles with source snippets and relevant graph rows for LLM/IDE handoff.

`report unused-verbs` lists candidate dead programmed verbs with no resolved static callers and no known external reachability. By default it targets programmed `this none this` verbs, decoded from the packed verb argument-spec bits plus `prepositions: ["none"]`; use `--all-programmed` to widen the target set and `--require-execute` to only include `+x` verbs. This is conservative static reachability, not proof of deletion safety. Known ToastStunt listener/system/lifecycle hooks, protected built-in overrides such as `#0:bf_<function>`, and ToastCore core-extraction hooks are treated as used external entrypoints and reported separately from unused candidates.

`report unprogrammed-verbs` lists verb definitions that exist in the DB metadata but have no stored verb program (`hasProgram: false`). These are separate from unused programmed code; they can represent placeholders, command affordances, inherited behavior markers, or intentionally blank verb slots. The served HTML report includes them in an `Unprogrammed Verbs` tab.

`run-report` runs the full local pipeline from a ToastStunt checkpoint DB and writes a persistent report run:

```text
reports/<db>/<timestamp>/
  extract/
  graph/
  resolved/
  report/
    summary.json
    code_bugs.jsonl
    code_insights.jsonl
    mutation_invariants.jsonl
    handled_expected.jsonl
    dead_code.jsonl
    graph_refinement.jsonl
  manifest.json
reports/<db>/latest.json
reports/index.json
```

The DB name defaults to the input file stem and can be overridden with `--db-name`. `reports/index.json` tracks available DBs/runs and the latest run so the dynamic web UI can default to the newest report.

`serve reports` starts the dynamic React/Express report app for a persistent reports directory. It serves the UI at `/`, catalog data at `/api/catalog`, report summaries at `/api/reports/:db/:run/summary`, and paged/filterable items at `/api/reports/:db/:run/items`. The UI groups findings into `Code Bugs`, `Code Improvements`, `Dead Code`, `Handled / Expected`, and `Dynamic Resolution`, with server-side scoped search and bucket/reason counts.

`serve report` starts a basic dependency-free web server for issue triage. It serves a human-readable report at `/`, a JSON payload at `/report.json`, and `/healthz`. The HTML includes the issue-domain tabs plus an `Unused Verbs` tab when the resolved manifest points back to an extractor directory. The default bind is `0.0.0.0:8787`; use `--host`, `--port`, `--context-lines`, `--examples-per-reason`, and `--max-issues` to adjust output size and network exposure.

## Report Configuration

Report generation looks for `moo-code-graph.yaml` in the current working directory by default. If the file is missing, built-in defaults are used. Use `--config <path>` to load a different YAML file for commands that generate or serve report-derived views:

```bash
moo-code-graph run-report ./toastcore.db --db-name toastcore --config ./moo-code-graph.yaml
moo-code-graph report code-insights ./resolved/latest --config ./moo-code-graph.yaml
moo-code-graph report mutation-invariants ./resolved/latest --config ./moo-code-graph.yaml
moo-code-graph serve reports ./reports --config ./moo-code-graph.yaml
moo-code-graph serve report ./resolved/latest --config ./moo-code-graph.yaml
```

The dynamic report app's "generate from latest extract" action also uses the config path passed to `serve reports`. Restart the server after changing the YAML path or server code. If you edit the same config file in place, the next report generation loads the updated file.

Current default config:

```yaml
reports:
  codeInsights:
    minComplexity: 15
    minLines: 120
    minNesting: 4
    minPropertyWrites: 10
    minDynamicAccesses: 5
    minFanOut: 25
    minInlineErrorCount: 8
    minRepeatedStringCount: 3
    minRepeatedStringLength: 8
    minNormalizedDuplicateLines: 5
    includeUnusedDestructuringArgsWhenOtherArgsAreUsed: false
  deadCode:
    unusedVerbs:
      programmaticOnly: true
      requireExecute: false
  mutationInvariants:
    enabled: true
    ignoreProperties: []
    ignoreSourceVerbs: []
    ignoreBuckets: []
```

`reports.codeInsights` controls thresholds for the Code Improvements report and tab:

- `minComplexity`: minimum cyclomatic complexity before a verb is reported as high complexity.
- `minLines`: minimum non-blank source lines before a verb is reported as long.
- `minNesting`: minimum maximum control-flow nesting depth before a verb is reported as deeply nested.
- `minPropertyWrites`: minimum writes to object properties in one verb before reporting property-write concentration.
- `minDynamicAccesses`: minimum dynamic property/verb accesses in one verb before reporting dynamic access concentration.
- `minFanOut`: minimum distinct outgoing static call targets before reporting fan-out.
- `minInlineErrorCount`: minimum inline error handlers in one verb before reporting inline error handling concentration.
- `minRepeatedStringCount`: minimum repeats of the same string literal before reporting repeated strings.
- `minRepeatedStringLength`: minimum string literal length considered by the repeated-string check.
- `minNormalizedDuplicateLines`: minimum normalized comparable source lines before similar verb body detection reports a duplicate.
- `includeUnusedDestructuringArgsWhenOtherArgsAreUsed`: when `false`, suppresses unused destructuring-binding findings for a destructuring statement if any sibling binding from that same statement is read. Set to `true` to report each unused destructured binding independently.

`reports.deadCode.unusedVerbs` controls the unused programmed verb report:

- `programmaticOnly`: when `true`, only considers programmed `this none this` verbs as unused-code candidates. Set to `false` to consider all programmed verbs.
- `requireExecute`: when `true`, only includes executable verbs in the unused-code candidate set.

`reports.mutationInvariants` controls the Mutation / Invariants report and tab:

- `enabled`: when `false`, skips this report.
- `ignoreProperties`: suppresses properties by exact `#object.property` or glob-style `*.property`.
- `ignoreSourceVerbs`: suppresses writes from specific source verb ids such as `#4:151`.
- `ignoreBuckets`: suppresses buckets such as `shape_mismatch`, `object_scalar_mismatch`, `collection_shape_mismatch`, or `sensitive_shape_mismatch`.

CLI flags still take priority for the narrow checks they directly expose. For example, `report code-insights --min-nesting 5` overrides `reports.codeInsights.minNesting` for that command invocation, while the other YAML thresholds remain in effect.

## Resolution MVP

Resolve the safest raw references into identity edges:

```bash
moo-code-graph resolve ./graph/latest --extract ./extract/latest --out ./resolved/latest --overwrite
```

The resolver currently handles only:

- `$symbol` references backed by `core_candidates.jsonl`
- literal object references backed by `objects.jsonl`
- static verb-call candidates for identity-backed receivers, matched with ToastStunt wildcard verb semantics such as `l*ook` and `*`
- inherited verb-call candidates for identity-backed receivers through `objects.jsonl` parent links
- `this:verb(...)` candidates using the source verb's object and inherited lookup
- inline error context for unresolved verb calls guarded by `! E_VERBNF` or `! ANY`, and unresolved property accesses guarded by `! E_PROPNF` or `! ANY`; these are reported as handled inline issues, not definite issues
- static property candidates for `this.foo`, `#123.foo`, and `$symbol.foo`
- inherited property candidates through `objects.jsonl` parent links
- ToastStunt built-in object properties such as `name`, `owner`, `location`, and `contents`
- guarded runtime property accesses proven by local `$ou:has_property(receiver, "prop")` or `$object_utils:has_property(receiver, "prop")` predicates when no static or built-in property candidate exists
- simple local variable receivers when the latest prior local state has known identity in the same verb, such as `obj = #20`, `obj = this`, or `obj = $string_utils`
- local variable receivers assigned from object-valued property reads when extractor metadata gives one concrete object, such as `loc = obj.location`
- chained property receivers when the inner property resolves to a concrete object, such as `obj.location.owner`
- loop variables over concrete object-list properties when extractor metadata contains object refs, including `.contents`
- loop variables over `children(known_object)` and `parents(known_object)` using extractor parent/child metadata
- variable receiver diagnostics from destructuring and loop bindings, such as `destructured_variable_receiver` and `local_object_list_item_receiver`
- intraprocedural local variable state for receiver inference. The latest prior assignment wins, so `obj = #30; obj = args[1]; obj.name` is reported as an argument-derived runtime receiver, not stale `#30`.
- lightweight branch/loop context for local flow. Conditional object assignments merge into candidate sets; conditional runtime/unknown assignments downgrade later uses instead of over-resolving them.

Most runtime receiver semantics remain unresolved by design. The resolver does not resolve `player`, `caller`, branch-sensitive variable state, property receivers without concrete object-valued metadata, dynamic selectors, or computed property names. See [docs/resolution-design.md](docs/resolution-design.md).

Runtime object variables such as `dobj` and `iobj` are reported separately from unbound locals. They are valid ToastStunt built-ins, but their concrete object values are runtime/task dependent.

Resolved outputs include `edges/unresolved_refs.jsonl` and `edges/guarded_property_access_edges.jsonl` for machine consumption, plus `findings/unresolved_verb_calls.jsonl` / `findings/unresolved_property_accesses.jsonl` for humans. Human-facing resolver rows include `sourceVerbName` and `sourceLine` in addition to `sourceVerbId`, so a MOO operator can inspect the source verb directly.

Resolved verb and property candidate edges include `inheritancePath`, an object-ref array from the receiver object to the object that defined the matched verb or property. Direct and built-in matches have a one-item path.

Resolver flow outputs include:

```text
resolved/latest/
  flow/
    local_variable_states.jsonl
    inferred_receiver_candidates.jsonl
```

`local_variable_states.jsonl` records assignment, destructuring, loop-derived, and branch guard-derived local state with `valueKind`, `provenance`, `confidence`, optional `objects`, and optional unresolved `reason`. Positive `$ou:isa(x, target)`, `$object_utils:isa(x, target)`, and `isa(x, target)` guards are recorded with `provenance: "isa_guard"` when the guarded target resolves to an extractor object. Negative early-return guards such as `if (!$ou:isa(x, target)) return 0;` are recorded on reachable continuation paths with `provenance: "isa_exit_guard"`.

`inferred_receiver_candidates.jsonl` records the local state used at variable receiver sites for verb calls and property accesses. These rows are explanatory: they show why a receiver resolved to a candidate object set, including branch-local `isa_guard` and continuation `isa_exit_guard` refinements, or why it stayed unresolved as `argument_receiver`, `function_return_receiver`, `unknown_flow_receiver`, and similar reasons.

## Programmatic API

```ts
import {
  indexMooCodeGraph,
  inspectExtractDir,
  reportCoverage,
  validateExtractDir
} from "@sindomecorp/moo-code-graph";

await validateExtractDir("./extract/latest");
await inspectExtractDir("./extract/latest");
await indexMooCodeGraph({
  extractDir: "./extract/latest",
  outputDir: "./graph/latest",
  overwrite: true
});
await reportCoverage({ resolvedDir: "./resolved/latest" });
```

## Fact Types

The MVP emits:

- `verb_call` facts in `callsites.jsonl`
- `function_call` facts in `function_calls.jsonl`
- `object_reference` facts in `object_refs.jsonl`
- `system_object_ref` facts in `system_object_refs.jsonl`
- `property_access` and `computed_property_access` facts in `property_accesses.jsonl`
- `assignment` facts in `assignments.jsonl`
- `local_binding` facts in `local_bindings.jsonl`
- `destructuring_binding` facts in `destructuring_bindings.jsonl`
- `loop_binding` facts in `loop_bindings.jsonl`
- `comment` facts in `comments.jsonl`
- `parse_error` facts in `parse_errors.jsonl`

Comments use the durable MOO string-literal comment syntax supported by `tree-sitter-moo`, for example:

```moo
"This is a comment statement.";
```

## Node.js 26 validation

Validated on Linux with **Node.js 26.12.1** on **2026-10-26**. The TypeScript/Vite build and compiled unit/integration tests passed using test fixtures.

With Node.js 26.12.1 selected, reproduce the checks with:

```sh
npm run build
npm test
```
