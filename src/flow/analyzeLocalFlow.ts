import type {
  AssignmentInput,
  DestructuringBindingInput,
  LoopBindingInput
} from "../resolve/types.js";
import type {
  FlowUnresolvedReason,
  InferredReceiverCandidateFact,
  KnownObjectBindingInput,
  LocalVariableStateFact,
  VariableUseInput
} from "./types.js";

export interface AnalyzeLocalFlowInput {
  assignments: AssignmentInput[];
  destructuringBindings: DestructuringBindingInput[];
  loopBindings: LoopBindingInput[];
  knownObjectBindings: KnownObjectBindingInput[];
}

export interface LocalFlowAnalysis {
  states: LocalVariableStateFact[];
  lookupVariableState(input: Pick<VariableUseInput, "sourceVerbId" | "sourceObject" | "sourcePath" | "receiverRaw" | "line" | "column" | "controlFlowPath">): LocalVariableStateFact | undefined;
  buildInferredReceiverCandidates(uses: VariableUseInput[]): InferredReceiverCandidateFact[];
}

export function analyzeLocalFlow(input: AnalyzeLocalFlowInput): LocalFlowAnalysis {
  const knownByLocation = new Map(input.knownObjectBindings.map((binding) => [stateLocationKey(binding), binding]));
  const consumedKnownLocations = new Set<string>();
  const states: LocalVariableStateFact[] = [];

  for (const assignment of input.assignments) {
    if (!isIdentifier(assignment.leftText)) continue;
    const known = knownByLocation.get(stateLocationKey({ ...assignment, variable: assignment.leftText }));
    if (known) {
      consumedKnownLocations.add(stateLocationKey(known));
      states.push({
        kind: "local_variable_state",
        sourceVerbId: known.sourceVerbId,
        sourceObject: known.sourceObject,
        sourcePath: known.sourcePath,
        variable: known.variable,
        valueKind: known.valueKind,
        provenance: known.provenance,
        confidence: known.confidence,
        objects: known.objects,
        reason: known.reason,
        sourceText: known.sourceText ?? assignment.rightText,
        line: known.line,
        column: known.column,
        ...controlFlowFields(known)
      });
      continue;
    }

    const flow = classifyUnknownAssignment(assignment.rightText);
    states.push({
      kind: "local_variable_state",
      sourceVerbId: assignment.sourceVerbId,
      sourceObject: assignment.sourceObject,
      sourcePath: assignment.sourcePath,
      variable: assignment.leftText,
      valueKind: flow.valueKind,
      provenance: flow.provenance,
      confidence: flow.confidence,
      reason: flow.reason,
      sourceText: assignment.rightText,
      line: assignment.line,
      column: assignment.column,
      ...controlFlowFields(assignment)
    });
  }

  for (const binding of input.destructuringBindings) {
    states.push({
      kind: "local_variable_state",
      sourceVerbId: binding.sourceVerbId,
      sourceObject: binding.sourceObject,
      sourcePath: binding.sourcePath,
      variable: binding.variable,
      valueKind: "unknown",
      provenance: "destructuring",
      confidence: "unknown",
      reason: "destructured_variable_receiver",
      sourceText: binding.rightText,
      line: binding.line,
      column: binding.column,
      ...controlFlowFields(binding)
    });
  }

  for (const loop of input.loopBindings) {
    const known = knownByLocation.get(stateLocationKey(loop));
    if (known) {
      consumedKnownLocations.add(stateLocationKey(known));
      states.push({
        kind: "local_variable_state",
        sourceVerbId: known.sourceVerbId,
        sourceObject: known.sourceObject,
        sourcePath: known.sourcePath,
        variable: known.variable,
        valueKind: known.valueKind,
        provenance: known.provenance,
        confidence: known.confidence,
        objects: known.objects,
        reason: known.reason,
        sourceText: known.sourceText ?? loop.collectionText,
        line: known.line,
        column: known.column,
        ...controlFlowFields(known)
      });
      continue;
    }

    states.push({
      kind: "local_variable_state",
      sourceVerbId: loop.sourceVerbId,
      sourceObject: loop.sourceObject,
      sourcePath: loop.sourcePath,
      variable: loop.variable,
      valueKind: loop.collectionKind === "contents_property" ? "runtime_object_list_item" : "unknown",
      provenance: loop.collectionKind === "contents_property" ? "contents_builtin_loop" : "unknown_loop",
      confidence: loop.collectionKind === "contents_property" ? "runtime" : "unknown",
      reason: loop.collectionKind === "contents_property" ? "local_object_list_item_receiver" : "variable_receiver",
      sourceText: loop.collectionText,
      line: loop.line,
      column: loop.column,
      ...controlFlowFields(loop)
    });
  }

  for (const known of input.knownObjectBindings) {
    if (consumedKnownLocations.has(stateLocationKey(known))) continue;
    states.push({
      kind: "local_variable_state",
      sourceVerbId: known.sourceVerbId,
      sourceObject: known.sourceObject,
      sourcePath: known.sourcePath,
      variable: known.variable,
      valueKind: known.valueKind,
      provenance: known.provenance,
      confidence: known.confidence,
      objects: known.objects,
      reason: known.reason,
      sourceText: known.sourceText,
      line: known.line,
      column: known.column,
      ...controlFlowFields(known)
    });
  }

  states.sort(compareStates);
  const stateIndex = buildStateIndex(states);

  const lookupVariableState = (
    input: Pick<VariableUseInput, "sourceVerbId" | "sourceObject" | "sourcePath" | "receiverRaw" | "line" | "column" | "controlFlowPath">
  ): LocalVariableStateFact | undefined => {
    const candidates = stateIndex.get(variableKey(input.sourceVerbId, input.receiverRaw)) ?? [];
    const prior = candidates.filter((candidate) => isBefore(candidate, input));
    const sameScope = prior.filter((candidate) => !isTopLevel(candidate) && isSameControlFlowScope(candidate, input));
    if (sameScope.length > 0) return sameScope.at(-1);

    const latestTopLevel = prior.filter((candidate) => isTopLevel(candidate)).at(-1);
    const conditionalSinceTopLevel = prior.filter(
      (candidate) => !isTopLevel(candidate) && !isGuardProvenance(candidate.provenance) && (!latestTopLevel || isBefore(latestTopLevel, candidate))
    );
    const merged = mergeConditionalStates(input, latestTopLevel, conditionalSinceTopLevel);
    if (merged) return merged;

    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index]!;
      if (isBefore(candidate, input) && isTopLevel(candidate)) return candidate;
    }
    return undefined;
  };

  return {
    states,
    lookupVariableState,
    buildInferredReceiverCandidates(uses): InferredReceiverCandidateFact[] {
      const inferred: InferredReceiverCandidateFact[] = [];
      for (const use of uses) {
        const state = lookupVariableState(use);
        if (!state) continue;
        inferred.push({
          kind: "inferred_receiver_candidate",
          sourceVerbId: use.sourceVerbId,
          sourceObject: use.sourceObject,
          sourcePath: use.sourcePath,
          useKind: use.useKind,
          variable: use.receiverRaw,
          receiverRaw: use.receiverRaw,
          valueKind: state.valueKind,
          provenance: state.provenance,
          confidence: state.confidence,
          ...(state.objects ? { objects: state.objects } : {}),
          ...(state.reason ? { reason: state.reason } : {}),
          ...(use.sourceText ?? state.sourceText ? { sourceText: use.sourceText ?? state.sourceText } : {}),
          line: use.line,
          column: use.column,
          ...controlFlowFields(use)
        });
      }
      return inferred;
    }
  };
}

function mergeConditionalStates(
  use: Pick<VariableUseInput, "sourceVerbId" | "receiverRaw" | "sourceObject" | "sourcePath" | "line" | "column">,
  latestTopLevel: LocalVariableStateFact | undefined,
  conditionalStates: LocalVariableStateFact[]
): LocalVariableStateFact | undefined {
  if (conditionalStates.length === 0) return latestTopLevel;
  const allStates = latestTopLevel ? [latestTopLevel, ...conditionalStates] : conditionalStates;
  if (allStates.some((state) => !state.objects || state.objects.length === 0)) {
    const lastUnknown = [...allStates].reverse().find((state) => !state.objects || state.objects.length === 0);
    return {
      kind: "local_variable_state",
      sourceVerbId: use.sourceVerbId,
      sourceObject: use.sourceObject,
      sourcePath: use.sourcePath,
      variable: use.receiverRaw,
      valueKind: "unknown",
      provenance: "unknown_assignment",
      confidence: "unknown",
      reason: lastUnknown?.reason ?? "unknown_flow_receiver",
      sourceText: lastUnknown?.sourceText,
      line: use.line,
      column: use.column
    };
  }

  const objects = [...new Set(allStates.flatMap((state) => state.objects ?? []))];
  if (objects.length === 0) return undefined;
  return {
    kind: "local_variable_state",
    sourceVerbId: use.sourceVerbId,
    sourceObject: use.sourceObject,
    sourcePath: use.sourcePath,
    variable: use.receiverRaw,
    valueKind: objects.length === 1 ? "object" : "object_candidate_set",
    provenance: "unknown_assignment",
    confidence: objects.length === 1 ? "exact" : "candidate",
    objects,
    line: use.line,
    column: use.column
  };
}

function classifyUnknownAssignment(rightText: string): {
  valueKind: "runtime_object" | "unknown";
  provenance: "argument" | "known_runtime_object_function" | "function_return" | "unknown_assignment";
  confidence: "runtime" | "unknown";
  reason: FlowUnresolvedReason;
} {
  const text = rightText.trim();
  const lower = text.toLowerCase();
  if (lower === "args" || /^args\s*\[.+\]$/i.test(text)) {
    return { valueKind: "runtime_object", provenance: "argument", confidence: "runtime", reason: "argument_receiver" };
  }
  if (isKnownRuntimeObjectFunctionCall(text)) {
    return {
      valueKind: "runtime_object",
      provenance: "known_runtime_object_function",
      confidence: "runtime",
      reason: "runtime_object_function_receiver"
    };
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(text)) {
    return { valueKind: "unknown", provenance: "function_return", confidence: "unknown", reason: "function_return_receiver" };
  }
  return { valueKind: "unknown", provenance: "unknown_assignment", confidence: "unknown", reason: "unknown_flow_receiver" };
}

function isKnownRuntimeObjectFunctionCall(text: string): boolean {
  return /^caller_perms\s*\(\s*\)$/i.test(text);
}

function buildStateIndex(states: LocalVariableStateFact[]): Map<string, LocalVariableStateFact[]> {
  const index = new Map<string, LocalVariableStateFact[]>();
  for (const state of states) {
    const key = variableKey(state.sourceVerbId, state.variable);
    const existing = index.get(key) ?? [];
    existing.push(state);
    index.set(key, existing);
  }
  for (const existing of index.values()) existing.sort(compareStates);
  return index;
}

function stateLocationKey(input: { sourceVerbId: string; variable: string; line: number; column: number }): string {
  return `${input.sourceVerbId}\t${input.variable.toLowerCase()}\t${input.line}\t${input.column}`;
}

function variableKey(sourceVerbId: string, variable: string): string {
  return `${sourceVerbId}\t${variable.toLowerCase()}`;
}

function isIdentifier(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text);
}

function isGuardProvenance(provenance: LocalVariableStateFact["provenance"]): boolean {
  return (
    provenance === "isa_guard" ||
    provenance === "isa_exit_guard" ||
    provenance === "valid_guard" ||
    provenance === "valid_exit_guard" ||
    provenance === "match_failure_guard" ||
    provenance === "match_failure_exit_guard"
  );
}

function compareStates(left: Pick<LocalVariableStateFact, "sourceVerbId" | "line" | "column">, right: Pick<LocalVariableStateFact, "sourceVerbId" | "line" | "column">): number {
  return left.sourceVerbId.localeCompare(right.sourceVerbId) || left.line - right.line || left.column - right.column;
}

function isBefore(left: Pick<LocalVariableStateFact, "line" | "column">, right: Pick<VariableUseInput, "line" | "column">): boolean {
  return left.line < right.line || (left.line === right.line && left.column < right.column);
}

function isTopLevel(state: Pick<LocalVariableStateFact, "controlFlowDepth">): boolean {
  return !state.controlFlowDepth || state.controlFlowDepth === 0;
}

function isSameControlFlowScope(
  state: Pick<LocalVariableStateFact, "controlFlowPath" | "provenance">,
  use: Pick<VariableUseInput, "controlFlowPath">
): boolean {
  const statePath = state.controlFlowPath ?? [];
  const usePath = use.controlFlowPath ?? [];
  if (statePath.length === 0) return usePath.length === 0;
  if (usePath.length < statePath.length) return false;
  if (state.provenance === "isa_guard" || state.provenance === "valid_guard" || state.provenance === "match_failure_guard") {
    const nextSegment = usePath[statePath.length];
    if (nextSegment?.startsWith("else_clause@") || nextSegment?.startsWith("elseif_clause@")) return false;
  }
  return statePath.every((segment, index) => usePath[index] === segment);
}

function controlFlowFields(input: {
  controlFlowKind?: LocalVariableStateFact["controlFlowKind"];
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}): Pick<LocalVariableStateFact, "controlFlowKind" | "controlFlowDepth" | "controlFlowPath"> {
  return {
    ...(input.controlFlowKind ? { controlFlowKind: input.controlFlowKind } : {}),
    ...(input.controlFlowDepth !== undefined ? { controlFlowDepth: input.controlFlowDepth } : {}),
    ...(input.controlFlowPath ? { controlFlowPath: input.controlFlowPath } : {})
  };
}
