import type { ObjectRef } from "@sindomecorp/toaststunt-db-extractor";
import type { ControlFlowKind, SourceMetadata } from "../facts/types.js";

export type FlowValueKind = "object" | "object_candidate_set" | "runtime_object" | "runtime_object_list_item" | "unknown";

export type FlowProvenance =
  | "literal_object_assignment"
  | "system_object_assignment"
  | "this_assignment"
  | "object_property_assignment"
  | "object_list_property_loop"
  | "children_builtin_loop"
  | "parents_builtin_loop"
  | "contents_builtin_loop"
  | "isa_guard"
  | "isa_exit_guard"
  | "valid_guard"
  | "valid_exit_guard"
  | "match_failure_guard"
  | "match_failure_exit_guard"
  | "known_runtime_object_function"
  | "destructuring"
  | "argument"
  | "function_return"
  | "unknown_assignment"
  | "unknown_loop";

export type FlowConfidence = "exact" | "candidate" | "runtime" | "unknown";

export type FlowUnresolvedReason =
  | "argument_receiver"
  | "function_return_receiver"
  | "runtime_object_receiver"
  | "validated_runtime_object_receiver"
  | "runtime_object_function_receiver"
  | "destructured_variable_receiver"
  | "runtime_object_list_item_receiver"
  | "unknown_flow_receiver"
  | "local_object_list_item_receiver"
  | "variable_receiver";

export interface LocalVariableStateFact extends SourceMetadata {
  kind: "local_variable_state";
  variable: string;
  valueKind: FlowValueKind;
  provenance: FlowProvenance;
  confidence: FlowConfidence;
  objects?: ObjectRef[];
  reason?: FlowUnresolvedReason;
  sourceText?: string;
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

export interface InferredReceiverCandidateFact extends SourceMetadata {
  kind: "inferred_receiver_candidate";
  useKind: "verb_call" | "property_access";
  variable: string;
  receiverRaw: string;
  valueKind: FlowValueKind;
  provenance: FlowProvenance;
  confidence: FlowConfidence;
  objects?: ObjectRef[];
  reason?: FlowUnresolvedReason;
  sourceText?: string;
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

export interface KnownObjectBindingInput extends SourceMetadata {
  variable: string;
  objects?: ObjectRef[];
  valueKind: "object" | "object_candidate_set" | "runtime_object";
  provenance:
    | "literal_object_assignment"
    | "system_object_assignment"
    | "this_assignment"
    | "object_property_assignment"
    | "object_list_property_loop"
    | "children_builtin_loop"
    | "parents_builtin_loop"
    | "contents_builtin_loop"
    | "isa_guard"
    | "isa_exit_guard"
    | "valid_guard"
    | "valid_exit_guard"
    | "match_failure_guard"
    | "match_failure_exit_guard"
    | "known_runtime_object_function";
  confidence: "exact" | "candidate" | "runtime";
  reason?: FlowUnresolvedReason;
  sourceText?: string;
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

export interface VariableUseInput extends SourceMetadata {
  useKind: "verb_call" | "property_access";
  receiverRaw: string;
  sourceText?: string;
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}
