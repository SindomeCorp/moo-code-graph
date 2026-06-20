import type { ObjectRef } from "@sindomecorp/toaststunt-db-extractor";
import type { AccessKind, ControlFlowKind, InlineErrorContext, ObjectRefContext, ReceiverKind, SelectorKind, SourceMetadata } from "../facts/types.js";
import type { InferredReceiverCandidateFact, LocalVariableStateFact } from "../flow/types.js";

export interface ResolveMooCodeGraphOptions {
  graphDir: string;
  extractDir: string;
  outputDir: string;
  overwrite?: boolean;
  pretty?: boolean;
  quiet?: boolean;
  onProgress?: (event: ResolveProgressEvent) => void;
}

export interface ResolveProgressEvent {
  phase:
    | "load_graph"
    | "load_extract"
    | "resolve_system_objects"
    | "resolve_literal_objects"
    | "resolve_verb_calls"
    | "resolve_property_accesses"
    | "emit_edges"
    | "write_manifest"
    | "done";
  message?: string;
  current?: number;
  total?: number;
}

export interface ResolveStats {
  systemObjectRefCount: number;
  resolvedSystemObjectRefCount: number;
  unresolvedSystemObjectRefCount: number;
  rootPropertyRefCount: number;
  resolvedRootPropertyRefCount: number;
  rootVerbFunctionCallCount: number;
  resolvedRootVerbFunctionCallCount: number;
  unresolvedRootVerbFunctionCallCount: number;
  literalObjectRefCount: number;
  resolvedLiteralObjectRefCount: number;
  unresolvedLiteralObjectRefCount: number;
  staticVerbCallsiteCount: number;
  resolvedVerbCallCandidateCount: number;
  inheritedVerbCallCandidateCount: number;
  unresolvedVerbCallCandidateCount: number;
  staticPropertyAccessCount: number;
  resolvedPropertyCandidateCount: number;
  inheritedPropertyCandidateCount: number;
  builtInPropertyCandidateCount: number;
  guardedPropertyAccessCount: number;
  guardedVerbCallCount: number;
  unresolvedPropertyAccessCount: number;
  localVariableStateCount: number;
  inferredReceiverCandidateCount: number;
}

export interface ResolveResult {
  graphDir: string;
  extractDir: string;
  outputDir: string;
  stats: ResolveStats;
}

export interface SystemObjectRefInput extends SourceMetadata {
  kind: "system_object_ref";
  symbol: `$${string}` | string;
  context: ObjectRefContext;
  line: number;
  column: number;
}

export interface ObjectRefInput extends SourceMetadata {
  kind: "object_reference";
  object: ObjectRef | string;
  context: ObjectRefContext;
  line: number;
  column: number;
}

export interface CallsiteInput extends SourceMetadata, InlineErrorContext {
  kind: "verb_call";
  receiverKind: ReceiverKind;
  receiverRaw: string;
  selectorKind: SelectorKind;
  selector?: string;
  selectorExpression?: string;
  argumentsText: string;
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

export interface FunctionCallInput extends SourceMetadata, InlineErrorContext {
  kind: "function_call";
  function: string;
  argumentsText: string;
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

export interface PropertyAccessInput extends SourceMetadata, InlineErrorContext {
  kind: "property_access" | "computed_property_access";
  receiverKind: ReceiverKind;
  receiverRaw: string;
  accessKind: AccessKind;
  propertyKind: "static" | "computed";
  property?: string;
  propertyExpression?: string;
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

export interface AssignmentInput extends SourceMetadata {
  kind: "assignment";
  assignmentKind: "statement" | "expression";
  leftText: string;
  rightText: string;
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

export interface LocalBindingInput extends SourceMetadata {
  kind: "local_binding";
  variable: string;
  bindingKind: "literal_object" | "system_object" | "this";
  rightText: string;
  object?: string;
  symbol?: string;
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

export interface DestructuringBindingInput extends SourceMetadata {
  kind: "destructuring_binding";
  variable: string;
  patternText: string;
  rightText: string;
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

export interface LoopBindingInput extends SourceMetadata {
  kind: "loop_binding";
  variable: string;
  collectionText: string;
  collectionKind: "contents_property" | "unknown";
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

export interface BranchGuardInput extends SourceMetadata {
  kind: "branch_guard";
  guardKind: "isa" | "has_property" | "has_callable_verb" | "has_verb" | "valid" | "match_failure";
  guardPolarity: "positive" | "negative";
  guardScope: "branch" | "conditional_expression" | "sibling_continuation" | "post_continuation";
  terminalKind?: "return";
  variable?: string;
  targetKind?: "system_object" | "literal_object";
  targetRaw?: string;
  receiverKind?: ReceiverKind;
  receiverRaw?: string;
  property?: string;
  verb?: string;
  guardedLine?: number;
  guardedColumn?: number;
  conditionText: string;
  guardText: string;
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

export interface SystemObjectEdge extends SourceMetadata {
  kind: "system_object_edge";
  line: number;
  column: number;
  symbol: string;
  targetObject: ObjectRef;
  resolutionKind: "core_candidate";
  confidence: string;
  context: ObjectRefContext;
}

export interface RootPropertyEdge extends SourceMetadata {
  kind: "root_property_edge";
  line: number;
  column: number;
  sourceVerbName: string;
  symbol: string;
  property: string;
  targetObject: "#0";
  definedOn: "#0";
  propertyId: string;
  definitionIndex?: number;
  accessKind: AccessKind | "expression";
  resolutionKind: "root_property";
  confidence: "exact";
  context: ObjectRefContext;
}

export interface RootVerbCallEdge extends SourceMetadata {
  kind: "root_verb_call_edge";
  line: number;
  column: number;
  sourceVerbName: string;
  function: string;
  selector: string;
  argumentsText: string;
  targetObject: "#0";
  definedOn: ObjectRef;
  inheritanceDepth: number;
  inheritancePath: ObjectRef[];
  targetVerbId: `${ObjectRef}:${number}`;
  resolutionKind: "root_verb_function_call" | "inherited_root_verb_function_call";
  confidence: "candidate";
  inlineErrorHandled?: boolean;
  inlineErrorCodes?: string[];
  inlineErrorFallbackText?: string;
  inlineErrorExpressionText?: string;
}

export interface LiteralObjectEdge extends SourceMetadata {
  kind: "literal_object_edge";
  line: number;
  column: number;
  object: string;
  targetObject: ObjectRef;
  resolutionKind: "literal_object" | "special_literal_object";
  specialName?: "$nothing" | "$ambiguous_match" | "$failed_match";
  context: ObjectRefContext;
}

export interface VerbCallCandidateEdge extends SourceMetadata {
  kind: "verb_call_candidate_edge";
  line: number;
  column: number;
  sourceVerbName: string;
  receiverKind: ReceiverKind;
  receiverRaw: string;
  receiverObject: ObjectRef;
  selector: string;
  targetObject: ObjectRef;
  definedOn: ObjectRef;
  inheritanceDepth: number;
  inheritancePath: ObjectRef[];
  targetVerbId: `${ObjectRef}:${number}`;
  resolutionKind:
    | "static_receiver_static_selector"
    | "inherited_static_receiver_static_selector"
    | "this_static_selector"
    | "this_inherited_static_selector";
  confidence: "candidate";
}

export interface PropertyCandidateEdge extends SourceMetadata {
  kind: "property_candidate_edge";
  line: number;
  column: number;
  sourceVerbName: string;
  accessKind: AccessKind;
  receiverKind: ReceiverKind;
  receiverRaw: string;
  receiverObject: ObjectRef;
  property: string;
  propertyExpression?: string;
  possibleProperties?: string[];
  targetObject: ObjectRef;
  definedOn: ObjectRef | "builtin";
  inheritanceDepth: number;
  inheritancePath: ObjectRef[];
  propertyId: string;
  definitionIndex?: number;
  resolutionKind:
    | "static_receiver_static_property"
    | "inherited_static_receiver_static_property"
    | "this_static_property"
    | "this_inherited_static_property"
    | "this_verb_alias_property"
    | "this_inherited_verb_alias_property"
    | "computed_properties_loop_property"
    | "computed_inherited_properties_loop_property"
    | "built_in_property"
    | "chained_property_receiver";
  confidence: "candidate";
}

export interface GuardedPropertyAccessEdge extends SourceMetadata {
  kind: "guarded_property_access_edge";
  line: number;
  column: number;
  sourceVerbName: string;
  accessKind: AccessKind;
  receiverKind: ReceiverKind;
  receiverRaw: string;
  receiverObject?: ObjectRef;
  property: string;
  ref: string;
  guardText: string;
  guardScope: BranchGuardInput["guardScope"];
  resolutionKind: "has_property_guarded_property" | "isa_guarded_property";
  confidence: "guarded";
}

export interface GuardedVerbCallEdge extends SourceMetadata {
  kind: "guarded_verb_call_edge";
  line: number;
  column: number;
  sourceVerbName: string;
  receiverKind: ReceiverKind;
  receiverRaw: string;
  receiverObject?: ObjectRef;
  selector: string;
  ref: string;
  guardText: string;
  guardScope: BranchGuardInput["guardScope"];
  resolutionKind: "has_callable_verb_guarded_call" | "has_verb_guarded_call";
  confidence: "guarded";
}

export interface UnresolvedRef extends SourceMetadata {
  kind: "unresolved_ref";
  line: number;
  column: number;
  sourceVerbName: string;
  refKind: "system_object" | "literal_object" | "verb_call";
  ref: string;
  reason:
    | "no_core_candidate"
    | "core_collection_candidate"
    | "core_candidate_missing_target_object"
    | "missing_object"
    | "unresolved_receiver"
    | "no_matching_verb"
    | "no_matching_direct_or_inherited_verb"
    | "no_matching_property"
    | "ancestor_cycle"
    | "dynamic_selector"
    | "unsupported_receiver"
    | "variable_receiver"
    | "player_receiver"
    | "caller_receiver"
    | "property_receiver"
    | "computed_property_receiver"
    | "expression_receiver"
    | "unknown_receiver"
    | "ambiguous_variable_receiver"
    | "no_matching_content_item_candidate"
    | "runtime_object_receiver"
    | "argument_receiver"
    | "function_return_receiver"
    | "validated_runtime_object_receiver"
    | "runtime_object_function_receiver"
    | "runtime_property_chain_receiver"
    | "unknown_flow_receiver"
    | "runtime_object_list_item_receiver"
    | "unbound_variable_receiver"
    | "destructured_variable_receiver"
    | "local_object_list_item_receiver"
    | "dynamic_property";
  context?: ObjectRefContext;
  receiverRaw?: string;
  receiverObject?: ObjectRef;
  candidateObjects?: ObjectRef[];
  compositionKind?: "feature_list_hook";
  optionalHookHandled?: boolean;
  selector?: string;
  selectorExpression?: string;
  inlineErrorHandled?: boolean;
  inlineErrorCodes?: string[];
  inlineErrorFallbackText?: string;
  inlineErrorExpressionText?: string;
}

export interface UnresolvedVerbCallFinding extends SourceMetadata {
  kind: "unresolved_verb_call";
  severity: "warning";
  line: number;
  column: number;
  sourceVerbName: string;
  sourceLine?: string;
  ref: string;
  reason: UnresolvedRef["reason"];
  receiverRaw?: string;
  receiverObject?: ObjectRef;
  candidateObjects?: ObjectRef[];
  compositionKind?: "feature_list_hook";
  optionalHookHandled?: boolean;
  selector?: string;
  selectorExpression?: string;
  inlineErrorHandled?: boolean;
  inlineErrorCodes?: string[];
  inlineErrorFallbackText?: string;
  inlineErrorExpressionText?: string;
}

export interface UnresolvedPropertyAccessFinding extends SourceMetadata {
  kind: "unresolved_property_access";
  severity: "warning";
  line: number;
  column: number;
  sourceVerbName: string;
  sourceLine?: string;
  ref: string;
  reason: UnresolvedRef["reason"];
  accessKind: AccessKind;
  receiverKind: ReceiverKind;
  receiverRaw: string;
  receiverObject?: ObjectRef;
  property?: string;
  propertyExpression?: string;
  possibleProperties?: string[];
  missingProperties?: string[];
  inlineErrorHandled?: boolean;
  inlineErrorCodes?: string[];
  inlineErrorFallbackText?: string;
  inlineErrorExpressionText?: string;
}

export interface ResolvedEdges {
  systemObjectEdges: SystemObjectEdge[];
  rootPropertyEdges: RootPropertyEdge[];
  rootVerbCallEdges: RootVerbCallEdge[];
  literalObjectEdges: LiteralObjectEdge[];
  verbCallCandidateEdges: VerbCallCandidateEdge[];
  propertyCandidateEdges: PropertyCandidateEdge[];
  guardedPropertyAccessEdges: GuardedPropertyAccessEdge[];
  guardedVerbCallEdges: GuardedVerbCallEdge[];
  unresolvedRefs: UnresolvedRef[];
  unresolvedVerbCallFindings: UnresolvedVerbCallFinding[];
  unresolvedPropertyAccessFindings: UnresolvedPropertyAccessFinding[];
  localVariableStates: LocalVariableStateFact[];
  inferredReceiverCandidates: InferredReceiverCandidateFact[];
}
