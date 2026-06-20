# Raw Code Fact Schema

This document describes the raw JSONL output emitted by `@sindomecorp/moo-code-graph`.

The current schema version is `raw-code-facts/v7`.

## Guarantees

Every fact row emitted from verb source includes:

- `kind`: fact discriminator.
- `sourceVerbId`: extractor verb id, for example `#20:0`.
- `sourceObject`: extractor object ref, for example `#20`.
- `sourcePath`: path from extractor output root to the source file.
- `line`: zero-based Tree-sitter start line.
- `column`: zero-based Tree-sitter start column.

Most syntax facts also include lightweight control-flow context:

- `controlFlowKind`: `"top_level" | "branch" | "loop" | "branch_loop"`
- `controlFlowDepth`: number of branch/loop ancestors
- `controlFlowPath`: stable-enough ancestor path entries using node type and source range

These fields are intended for conservative local flow analysis. They are not a complete control-flow graph.

Rows are raw syntax facts. They are not resolved graph edges. This package does not resolve `$foo` to object ids, `this` to runtime receivers, inherited verbs, inherited properties, or `player:tell()` to concrete verb definitions.

## Manifest

`manifest.json`:

```json
{
  "sourceExtractDir": "./extract/latest",
  "sourceSnapshotId": "latest",
  "indexerVersion": "0.1.0",
  "factSchemaVersion": "raw-code-facts/v7",
  "startedAt": "2026-06-11T00:00:00.000Z",
  "completedAt": "2026-06-11T00:00:10.000Z",
  "tool": "moo-code-graph",
  "mode": "raw-code-facts"
}
```

## `code_facts/callsites.jsonl`

One row per `verb_call`.

Required fields:

- `kind`: `"verb_call"`
- source metadata fields
- `receiverKind`: `"this" | "player" | "caller" | "literal_object" | "system_object" | "variable" | "property_access" | "computed_property_access" | "expression" | "unknown"`
- `receiverRaw`: raw receiver text
- `selectorKind`: `"static" | "dynamic" | "unknown"`
- `argumentsText`: raw argument-list text

Static selector fields:

- `selector`: verb name

Dynamic selector fields:

- `selectorExpression`: raw expression text

Example:

```json
{"kind":"verb_call","sourceVerbId":"#20:0","sourceObject":"#20","sourcePath":"verb_code/0000000020.0000.test.abc123.moo","receiverKind":"system_object","receiverRaw":"$string_utils","selectorKind":"static","selector":"trim","argumentsText":"(foo)","line":3,"column":0}
```

## `code_facts/function_calls.jsonl`

One row per `function_call`.

Required fields:

- `kind`: `"function_call"`
- source metadata fields
- `function`: raw function node text
- `argumentsText`: raw argument-list text

Example:

```json
{"kind":"function_call","sourceVerbId":"#20:0","sourceObject":"#20","sourcePath":"verb_code/0000000020.0000.test.abc123.moo","function":"tostr","argumentsText":"(#30)","line":12,"column":9}
```

## `code_facts/object_refs.jsonl`

One row per `object_reference`.

Required fields:

- `kind`: `"object_reference"`
- source metadata fields
- `object`: raw object ref, for example `#30`
- `context`: `"verb_call_receiver" | "expression" | "argument" | "assignment_left" | "assignment_right" | "property_receiver" | "unknown"`

## `code_facts/system_object_refs.jsonl`

One row per `system_object`.

Required fields:

- `kind`: `"system_object_ref"`
- source metadata fields
- `symbol`: raw system object symbol, for example `$string_utils`
- `context`: same context enum as object refs

## `code_facts/property_accesses.jsonl`

One row per `property_access` or `computed_property_access`.

Required fields:

- `kind`: `"property_access" | "computed_property_access"`
- source metadata fields
- `accessKind`: `"read" | "write"`
- `receiverKind`: same receiver enum as callsites
- `receiverRaw`: raw receiver text
- `propertyKind`: `"static" | "computed"`

Static property fields:

- `property`: property identifier

Computed property fields:

- `propertyExpression`: raw expression text

## `code_facts/branch_guards.jsonl`

One row per supported branch-local receiver guard.

Required fields:

- `kind`: `"branch_guard"`
- source metadata fields
- `guardKind`: `"isa" | "has_property" | "has_callable_verb" | "has_verb" | "valid" | "match_failure"`
- `guardPolarity`: `"positive" | "negative"`
- `guardScope`: `"branch" | "conditional_expression" | "sibling_continuation" | "post_continuation"`
- `conditionText`: raw branch condition text
- `guardText`: raw guard call text
- `terminalKind`: `"return"` for negative early-return continuation guards

Guard-specific fields:

- `isa`: `targetKind`, `targetRaw`, optional `variable`, optional `receiverKind`, and optional `receiverRaw`. `variable` is present when the guarded receiver is an identifier; property-access receivers use `receiverKind` and `receiverRaw`.
- `has_property`: `receiverKind`, `receiverRaw`, and static string `property`.
- `has_callable_verb` / `has_verb`: `receiverKind`, `receiverRaw`, and static string `verb`.
- `valid` / `match_failure`: `variable`.
- `guardedLine`, `guardedColumn`: exact guarded access location for conditional-expression guards when available.

The extractor recognizes positive `isa`, `valid`, match-failure, `$ou:has_property(receiver, "prop")` / `$object_utils:has_property(receiver, "prop")`, and `$ou:has_callable_verb(receiver, "verb")` / `$object_utils:has_verb(receiver, "verb")` guards in `if` and `elseif` conditions when they appear directly or under `&&` conjunctions:

```moo
if ($ou:isa(x, $freq_booster) && x.powered)
  x.interference_modifier;
endif
```

It also recognizes negative early-return guard clauses and emits continuation scoped rows:

```moo
if (!$ou:isa(what, $player))
  return 0;
elseif (`what.location ! ANY => ""')
  what:finish_action();
endif
what.location;
```

Conditional `has_property` guards are scoped to the positive arm only:

```moo
$object_utils:has_property(this, "namec") ? this.namec | fallback
```

Example:

```json
{"kind":"branch_guard","sourceVerbId":"#20:0","sourceObject":"#20","sourcePath":"verb_code/0000000020.0000.test.abc123.moo","line":3,"column":4,"controlFlowKind":"branch","controlFlowDepth":1,"controlFlowPath":["if_statement@3:0-5:5"],"guardKind":"isa","guardPolarity":"positive","guardScope":"branch","variable":"x","targetKind":"system_object","targetRaw":"$freq_booster","conditionText":"($ou:isa(x, $freq_booster) && x.powered)","guardText":"$ou:isa(x, $freq_booster)"}
```

```json
{"kind":"branch_guard","sourceVerbId":"#20:0","sourceObject":"#20","sourcePath":"verb_code/0000000020.0000.test.abc123.moo","line":12,"column":4,"controlFlowKind":"branch","controlFlowDepth":1,"controlFlowPath":["if_statement@12:0-14:5"],"guardKind":"has_property","guardPolarity":"positive","guardScope":"branch","receiverKind":"variable","receiverRaw":"x","property":"p","conditionText":"($ou:has_property(x, \"p\"))","guardText":"$ou:has_property(x, \"p\")"}
```

```json
{"kind":"branch_guard","sourceVerbId":"#20:0","sourceObject":"#20","sourcePath":"verb_code/0000000020.0000.test.abc123.moo","line":20,"column":4,"controlFlowKind":"branch","controlFlowDepth":1,"controlFlowPath":["if_statement@20:0-22:5"],"guardKind":"has_callable_verb","guardPolarity":"positive","guardScope":"branch","receiverKind":"variable","receiverRaw":"x","verb":"boosted","conditionText":"($ou:has_callable_verb(x, \"boosted\"))","guardText":"$ou:has_callable_verb(x, \"boosted\")"}
```

Write detection is syntax-only. A property access is a write when it is the direct left side of `assignment_statement` or `assignment_expression`; otherwise it is a read.

## `code_facts/assignments.jsonl`

One row per `assignment_statement` or `assignment_expression`.

Required fields:

- `kind`: `"assignment"`
- source metadata fields
- `assignmentKind`: `"statement" | "expression"`
- `leftText`: raw left-hand side text
- `rightText`: raw right-hand side text

## `code_facts/local_bindings.jsonl`

One row per simple local variable assignment to a syntactically known object identity.

Required fields:

- `kind`: `"local_binding"`
- source metadata fields
- `variable`: local variable name on the left-hand side
- `bindingKind`: `"literal_object" | "system_object" | "this"`
- `rightText`: raw right-hand side text

Literal object binding fields:

- `object`: object ref, for example `#30`

System object binding fields:

- `symbol`: system object symbol, for example `$string_utils`

Only direct assignments such as `obj = #30`, `obj = $string_utils`, and `obj = this` are emitted. This is not full data-flow analysis.

## `code_facts/destructuring_bindings.jsonl`

One row per identifier introduced by a scatter/destructuring assignment.

Required fields:

- `kind`: `"destructuring_binding"`
- source metadata fields
- `variable`: variable name introduced by the pattern
- `patternText`: raw left-hand side pattern text
- `rightText`: raw right-hand side text

Example:

```moo
{object, verbname} = args;
```

emits one row for `object` and one row for `verbname`.

## `code_facts/loop_bindings.jsonl`

One row per loop variable introduced by a `for` statement.

Required fields:

- `kind`: `"loop_binding"`
- source metadata fields
- `variable`: loop variable name
- `collectionText`: raw collection expression text
- `collectionKind`: `"contents_property" | "unknown"`

`contents_property` means the loop iterates over a `.contents` property. This indicates object-list item shape, not a single concrete object identity.

## `code_facts/comments.jsonl`

One row per Tree-sitter `comment` node. In `tree-sitter-moo`, durable comments are string-literal comment statements.

Required fields:

- `kind`: `"comment"`
- source metadata fields
- `text`: raw comment node text

Example:

```moo
"This is a MOO comment statement.";
```

## `code_facts/parse_errors.jsonl`

One row per Tree-sitter `ERROR` node or per unreadable source file.

Required fields:

- `kind`: `"parse_error"`
- source metadata fields
- `message`: error message

Optional diagnostic fields:

- `errorText`: raw text covered by the Tree-sitter `ERROR` node, or empty string for file read errors
- `parentType`: Tree-sitter parent node type when available
- `sourceLine`: full source line where the error starts when available

DB-stored ToastStunt code has already passed ToastStunt compile checks. For real DB extracts, any nonzero parse-error count should be treated as a likely `tree-sitter-moo` grammar gap and surfaced immediately.

## `code_facts/stats.json`

Aggregate counts:

```json
{
  "verbCount": 1,
  "verbCodeFileCount": 1,
  "parsedFileCount": 1,
  "parseErrorCount": 0,
  "callsiteCount": 5,
  "functionCallCount": 1,
  "objectRefCount": 2,
  "systemObjectRefCount": 1,
  "propertyAccessCount": 3,
  "assignmentCount": 2,
  "localBindingCount": 1,
  "destructuringBindingCount": 0,
  "loopBindingCount": 0,
  "branchGuardCount": 0,
  "commentCount": 1
}
```
