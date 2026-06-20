# Resolution Design

`moo-code-graph resolve` converts selected raw syntax facts into conservative resolved reference edges.

This is not full semantic call resolution. It resolves conservative direct and inherited verb and property candidates when the receiver identity is known from a literal object, `$core` candidate, `this` in a source verb, or a narrow intraprocedural local variable state. It does not resolve `player`, `caller`, computed receivers, dynamic selectors, computed property names, or arbitrary runtime values.

## Inputs

Resolver inputs:

```text
graph/latest/
  manifest.json
  code_facts/
    system_object_refs.jsonl
    object_refs.jsonl
    local_bindings.jsonl
    destructuring_bindings.jsonl
    loop_bindings.jsonl

extract/latest/
  manifest.json
  objects.jsonl
  core_candidates.jsonl
```

The resolver consumes raw graph output. It does not parse MOO source.

## Outputs

```text
resolved/latest/
  manifest.json
  edges/
    system_object_edges.jsonl
    literal_object_edges.jsonl
    verb_call_candidate_edges.jsonl
    property_candidate_edges.jsonl
    unresolved_refs.jsonl
    stats.json
  findings/
    unresolved_verb_calls.jsonl
    unresolved_property_accesses.jsonl
  flow/
    local_variable_states.jsonl
    inferred_receiver_candidates.jsonl
```

`manifest.json` includes:

```json
{
  "tool": "moo-code-graph",
  "mode": "resolved-reference-edges",
  "sourceGraphDir": "./graph/latest",
  "sourceExtractDir": "./extract/latest",
  "sourceFactSchemaVersion": "raw-code-facts/v7",
  "resolutionSchemaVersion": "resolved-reference-edges/v5"
}
```

## Resolution Rules

System object refs:

- Resolve `$symbol` only when `core_candidates.jsonl` contains a `core_candidate` with the same `symbol` and a `target`.
- Emit `unresolved_ref` with `reason: "no_core_candidate"` when no candidate exists.
- Emit `unresolved_ref` with `reason: "core_collection_candidate"` for `core_collection_candidate`; collection expansion is deferred.
- Emit `unresolved_ref` with `reason: "core_candidate_missing_target_object"` when a `$symbol` maps to an object missing from `objects.jsonl`.

Literal object refs:

- Resolve `#N` only when `objects.jsonl` contains object id `#N`.
- Emit `unresolved_ref` with `reason: "missing_object"` when no object record exists.

Static verb call candidates:

- Resolve only `receiver:selector(...)` callsites where `receiver` is a literal object or a system object that resolves to an object, and `selector` is static.
- Resolve `this:selector(...)` callsites by treating `this` as the source verb's `sourceObject`.
- Resolve variable receivers only when local flow analysis shows a latest prior state with known object identity or a concrete object candidate set.
- Resolve variable receivers assigned from object-valued property reads only when the property value is known from object metadata or `property_values.jsonl`.
- Resolve loop variables over object-list properties only when the receiver object is known and extractor metadata contains concrete object refs. Built-in `.contents` uses object metadata; DB-defined list properties use `property_values.jsonl`. This emits candidates for each concrete item object.
- Resolve loop variables over `children(known_object)` and `parents(known_object)` using extractor `children` and `parents` metadata. This mirrors ToastStunt built-ins from `src/objects.cc`.
- Match candidates from `verbs.jsonl` by receiver object, using all verb aliases in `names`.
- Alias matching follows ToastStunt `verbcasecmp` behavior: exact names match case-insensitively, embedded `*` marks an optional suffix segment (`l*ook` matches `l`, `lo`, `loo`, and `look`), and terminal `*` matches any remaining selector text.
- If direct matches exist on the receiver object, emit direct candidate edges with `inheritanceDepth: 0`.
- If no direct match exists, walk parent objects from `objects.jsonl` and emit inherited candidate edges with `resolutionKind: "inherited_static_receiver_static_selector"` and `inheritanceDepth` set to the parent distance.
- Candidate edges include `inheritancePath`, starting with the receiver object and ending with the object that defines the matched verb.
- `this` callsites use `resolutionKind: "this_static_selector"` for direct matches and `resolutionKind: "this_inherited_static_selector"` for inherited matches.
- Parent traversal is cycle-safe. Cyclic ancestry without a matching verb emits `unresolved_ref` with `reason: "ancestor_cycle"`.
- Emit one candidate edge per matching verb record.
- Emit `unresolved_ref` with `refKind: "verb_call"` when the receiver identity is missing or no matching verb exists.
- Emit unresolved receiver findings with `reason: "unbound_variable_receiver"` when a variable receiver has no prior known object binding or shape evidence.
- Emit unresolved receiver findings with `reason: "runtime_object_receiver"` for built-in runtime object variables such as `dobj` and `iobj`. ToastStunt defines these slots in `src/sym_table.cc` and populates them in `src/execute.cc`; their concrete values are task/runtime dependent.
- Emit `unresolved_ref` with `reason: "destructured_variable_receiver"` when a variable receiver came from destructuring and no concrete object identity is known.
- Emit unresolved property findings with `reason: "local_object_list_item_receiver"` when a loop variable is iterating a `.contents` object-list source. This indicates object shape, but not one concrete target object.
- Emit unresolved receiver findings with `reason: "argument_receiver"`, `function_return_receiver`, or `unknown_flow_receiver` when the latest prior assignment overwrote a known object identity with a runtime argument, function return, or unsupported expression.
- Emit `unresolved_ref` with `reason: "no_matching_content_item_candidate"` when a concrete object-list loop variable is known but none of its item candidates define the requested verb or property.

The inheritance and wildcard behavior is modeled from ToastStunt `src/db_verbs.cc` (`db_find_callable_verb` / `find_callable_verbdef`) and `src/utils.cc` (`verbcasecmp`). This resolver still emits candidates rather than final runtime dispatch decisions.

Static property candidates:

- Resolve only static property accesses where the receiver is `this`, a literal object, or a system object that resolves to an object.
- Resolve `this.foo` by treating `this` as the source verb's `sourceObject`.
- Resolve variable property receivers only when `local_bindings.jsonl` shows exactly one prior identity binding for the variable in the same source verb.
- Resolve variable property receivers assigned from object-valued property reads when the object can be derived from built-in object properties (`owner`, `location`, `contents`) or extractor `property_values.jsonl`.
- Match DB property definitions from `properties.jsonl` case-insensitively, following ToastStunt `db_find_property`.
- Match ToastStunt built-in properties before DB definitions. Built-ins are emitted with `resolutionKind: "built_in_property"` and `definedOn: "builtin"`.
- If no direct property exists, walk parent objects from `objects.jsonl` and emit inherited candidate edges.
- Candidate edges include `inheritancePath`, starting with the receiver object and ending with the object that defines the matched property. Built-in property matches use a one-item path containing the receiver object.
- Computed property names such as `obj.(prop_name)` are emitted as unresolved property findings with `reason: "dynamic_property"`.
- Non-identity receivers are emitted as unresolved property findings with specific reasons such as `player_receiver`, `caller_receiver`, `variable_receiver`, `ambiguous_variable_receiver`, `runtime_property_chain_receiver`, `property_receiver`, or `expression_receiver`.
- Chained property receivers such as `obj.location.owner` resolve only when the inner property access resolves to a concrete object. The resolver uses object metadata for built-in `owner` and `location`, and object-valued rows from `property_values.jsonl` for DB-defined properties.
- Chained property receiver edges use `resolutionKind: "chained_property_receiver"`.

Local variable receiver resolution is intentionally narrow and intraprocedural. It consumes direct object identity bindings and object-valued property bindings such as:

```moo
obj = #30;
core = $string_utils;
self = this;
loc = obj.location;
```

It also resolves loop variables from concrete object-list metadata:

```moo
for item in room.contents
  item:look_self();
endfor

for feature in player.features
  feature:player_disconnected(player);
endfor

for child in children($generic_thing)
  child.name;
endfor
```

It does not model general control flow, function returns, list/map indexing, or object identity hidden in arbitrary expressions.

The local flow model is ordered by source position and uses raw fact control-flow metadata. The latest prior same-scope state wins for straight-line code:

```moo
obj = #30;
obj = args[1];
obj.name;
```

The final access is unresolved as `argument_receiver`; it is not resolved using the stale `#30` assignment.

When a top-level use follows conditional assignments, the resolver merges possible branch states conservatively:

```moo
if (flag)
  obj = #30;
else
  obj = #40;
endif
obj.shared;
```

The final access is treated as an object candidate set containing `#30` and `#40`. If any reaching branch state is runtime or unknown, the merged state is unresolved with the most specific available reason, such as `argument_receiver`.

Destructuring, loops, argument assignments, function-return assignments, and unknown assignments improve diagnostics when they do not resolve to concrete object ids.

The local flow model also supports `isa` receiver guards. Positive guards in `if` and `elseif` conditions refine a variable only inside that guarded branch:

```moo
if ($ou:isa(x, $freq_booster) && x.powered)
  x.interference_modifier;
endif
```

Supported guard forms are `$ou:isa(x, target)`, `$object_utils:isa(x, target)`, and builtin `isa(x, target)`, where `target` is a `$core` symbol or literal object ref. `$ou` is treated as the conventional short name for `$object_utils`. Guard targets must resolve to an extractor object before the resolver emits a guard-derived local state.

Negative early-return guards refine the continuation after the returning branch:

```moo
if (!$ou:isa(what, $player))
  return 0;
elseif (`what.location ! ANY => ""')
  what:finish_action();
endif
what.location;
```

The first returning branch does not receive the positive type. Sibling `elseif`/`else` clauses and code after the full `if` receive `provenance: "isa_exit_guard"`. This allows destructured or otherwise unknown receivers such as `what.location` to resolve as `$player`-shaped after the guard exits.

Guards are intentionally narrow. Positive branch guards apply through parenthesized expressions and `&&` conjunctions, including later terms in the same condition, but not through `||`, negation, `else` branches, dynamic targets, helper wrappers, or after the guarded branch. Negative continuation guards currently require the first branch to end in `return`. Guard-derived states appear in `flow/local_variable_states.jsonl` with `provenance: "isa_guard"` or `provenance: "isa_exit_guard"` and in `flow/inferred_receiver_candidates.jsonl` at guarded variable receiver uses.

Chained property receiver resolution is also intentionally narrow. It does not infer a single object from list-valued properties such as `contents`, boolean/permission built-ins such as `wizard`, or arbitrary property values unless `property_values.jsonl` contains a concrete object value.

Every resolved and unresolved row preserves raw source metadata:

- `sourceVerbId`
- `sourceVerbName`
- `sourceObject`
- `sourcePath`
- `sourceLine` on human-facing findings when the source file is readable
- `line`
- `column`

`sourceVerbName` is copied from the extractor's `primaryName` or first verb alias. It is included anywhere resolver output is intended to be inspected by humans, because ids like `#20:0` are stable but names are faster to debug in a live MOO.

## Edge Rows

`system_object_edges.jsonl`:

```json
{
  "kind": "system_object_edge",
  "sourceVerbId": "#20:0",
  "sourceObject": "#20",
  "sourcePath": "verb_code/0000000020.0000.test.abc123.moo",
  "line": 3,
  "column": 0,
  "symbol": "$string_utils",
  "targetObject": "#30",
  "resolutionKind": "core_candidate",
  "confidence": "object-property-on-root",
  "context": "verb_call_receiver"
}
```

`literal_object_edges.jsonl`:

```json
{
  "kind": "literal_object_edge",
  "sourceVerbId": "#20:0",
  "sourceObject": "#20",
  "sourcePath": "verb_code/0000000020.0000.test.abc123.moo",
  "line": 12,
  "column": 15,
  "object": "#30",
  "targetObject": "#30",
  "resolutionKind": "literal_object",
  "context": "argument"
}
```

`unresolved_refs.jsonl`:

```json
{
  "kind": "unresolved_ref",
  "sourceVerbId": "#20:0",
  "sourceVerbName": "test",
  "sourceObject": "#20",
  "sourcePath": "verb_code/0000000020.0000.test.abc123.moo",
  "sourceLine": "$missing:noop();",
  "line": 4,
  "column": 2,
  "refKind": "system_object",
  "ref": "$missing",
  "reason": "no_core_candidate",
  "context": "expression"
}
```

`verb_call_candidate_edges.jsonl`:

```json
{
  "kind": "verb_call_candidate_edge",
  "sourceVerbId": "#20:0",
  "sourceVerbName": "test",
  "sourceObject": "#20",
  "sourcePath": "verb_code/0000000020.0000.test.abc123.moo",
  "line": 3,
  "column": 0,
  "receiverKind": "system_object",
  "receiverRaw": "$string_utils",
  "receiverObject": "#30",
  "selector": "trim",
  "targetObject": "#30",
  "definedOn": "#30",
  "inheritanceDepth": 0,
  "inheritancePath": ["#30"],
  "targetVerbId": "#30:0",
  "resolutionKind": "static_receiver_static_selector",
  "confidence": "candidate"
}
```

`property_candidate_edges.jsonl`:

```json
{
  "kind": "property_candidate_edge",
  "sourceVerbId": "#20:0",
  "sourceVerbName": "test",
  "sourceObject": "#20",
  "sourcePath": "verb_code/0000000020.0000.test.abc123.moo",
  "line": 18,
  "column": 4,
  "accessKind": "read",
  "receiverKind": "this",
  "receiverRaw": "this",
  "receiverObject": "#20",
  "property": "foo",
  "targetObject": "#20",
  "definedOn": "#20",
  "inheritanceDepth": 0,
  "inheritancePath": ["#20"],
  "propertyId": "#20.foo",
  "definitionIndex": 0,
  "resolutionKind": "this_static_property",
  "confidence": "candidate"
}
```

`guarded_property_access_edges.jsonl` records static lookup misses that are locally validated by `$ou:has_property(receiver, "prop")` or `$object_utils:has_property(receiver, "prop")`. Static DB and built-in property matches still emit normal `property_candidate_edge` rows and take priority.

```json
{
  "kind": "guarded_property_access_edge",
  "sourceVerbId": "#20:0",
  "sourceVerbName": "test",
  "sourceObject": "#20",
  "sourcePath": "verb_code/0000000020.0000.test.abc123.moo",
  "line": 22,
  "column": 2,
  "accessKind": "read",
  "receiverKind": "variable",
  "receiverRaw": "x",
  "property": "p",
  "ref": "x.p",
  "guardText": "$ou:has_property(x, \"p\")",
  "guardScope": "branch",
  "resolutionKind": "has_property_guarded_property",
  "confidence": "guarded"
}
```

Built-in property candidate example:

```json
{
  "kind": "property_candidate_edge",
  "sourceVerbId": "#20:0",
  "sourceVerbName": "test",
  "sourceObject": "#20",
  "sourcePath": "verb_code/0000000020.0000.test.abc123.moo",
  "line": 23,
  "column": 16,
  "accessKind": "read",
  "receiverKind": "this",
  "receiverRaw": "this",
  "receiverObject": "#20",
  "property": "name",
  "targetObject": "#20",
  "definedOn": "builtin",
  "inheritanceDepth": 0,
  "inheritancePath": ["#20"],
  "propertyId": "builtin:name",
  "resolutionKind": "built_in_property",
  "confidence": "candidate"
}
```

Inherited candidate example:

```json
{
  "kind": "verb_call_candidate_edge",
  "sourceVerbId": "#20:0",
  "sourceVerbName": "test",
  "sourceObject": "#20",
  "sourcePath": "verb_code/0000000020.0000.test.abc123.moo",
  "line": 6,
  "column": 0,
  "receiverKind": "literal_object",
  "receiverRaw": "#40",
  "receiverObject": "#40",
  "selector": "match",
  "targetObject": "#1",
  "definedOn": "#1",
  "inheritanceDepth": 2,
  "inheritancePath": ["#40", "#30", "#1"],
  "targetVerbId": "#1:0",
  "resolutionKind": "inherited_static_receiver_static_selector",
  "confidence": "candidate"
}
```

`this` candidate example:

```json
{
  "kind": "verb_call_candidate_edge",
  "sourceVerbId": "#20:0",
  "sourceVerbName": "test",
  "sourceObject": "#20",
  "sourcePath": "verb_code/0000000020.0000.test.abc123.moo",
  "line": 1,
  "column": 0,
  "receiverKind": "this",
  "receiverRaw": "this",
  "receiverObject": "#20",
  "selector": "match",
  "targetObject": "#1",
  "definedOn": "#1",
  "inheritanceDepth": 1,
  "inheritancePath": ["#20", "#1"],
  "targetVerbId": "#1:0",
  "resolutionKind": "this_inherited_static_selector",
  "confidence": "candidate"
}
```

`findings/unresolved_verb_calls.jsonl`:

```json
{
  "kind": "unresolved_verb_call",
  "severity": "warning",
  "sourceVerbId": "#20:0",
  "sourceVerbName": "test",
  "sourceObject": "#20",
  "sourcePath": "verb_code/0000000020.0000.test.abc123.moo",
  "line": 4,
  "column": 2,
  "ref": "$missing:noop",
  "reason": "no_core_candidate",
  "receiverRaw": "$missing",
  "selector": "noop"
}
```

This findings file is a focused human-facing projection of unresolved verb-call rows from `edges/unresolved_refs.jsonl`. It intentionally preserves failures such as undefined `$core` symbols or missing verbs; those failures can indicate valid ToastStunt code that references unavailable runtime definitions.

`findings/unresolved_property_accesses.jsonl`:

```json
{
  "kind": "unresolved_property_access",
  "severity": "warning",
  "sourceVerbId": "#20:0",
  "sourceVerbName": "test",
  "sourceObject": "#20",
  "sourcePath": "verb_code/0000000020.0000.test.abc123.moo",
  "line": 24,
  "column": 15,
  "sourceLine": "missing_prop = this.missing_prop;",
  "ref": "this.missing_prop",
  "reason": "no_matching_property",
  "accessKind": "read",
  "receiverKind": "this",
  "receiverRaw": "this",
  "receiverObject": "#20",
  "property": "missing_prop"
}
```

Property accesses covered by `guarded_property_access_edge` are excluded from `unresolved_property_accesses.jsonl`.
