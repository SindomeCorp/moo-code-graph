import type { ExtractedVerbRecord } from "@sindomecorp/toaststunt-db-extractor";

export type ReceiverKind =
  | "this"
  | "player"
  | "caller"
  | "literal_object"
  | "system_object"
  | "variable"
  | "property_access"
  | "computed_property_access"
  | "expression"
  | "unknown";

export type SelectorKind = "static" | "dynamic" | "unknown";
export type AccessKind = "read" | "write";
export type ControlFlowKind = "top_level" | "branch" | "loop" | "branch_loop";

export interface SourceMetadata {
  sourceVerbId: ExtractedVerbRecord["id"];
  sourceObject: ExtractedVerbRecord["object"];
  sourcePath: string;
}

export interface LocatedFact extends SourceMetadata {
  line: number;
  column: number;
  controlFlowKind?: ControlFlowKind;
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

export interface InlineErrorContext {
  inlineErrorHandled?: boolean;
  inlineErrorCodes?: string[];
  inlineErrorFallbackText?: string;
  inlineErrorExpressionText?: string;
}

export interface ReceiverInfo {
  receiverKind: ReceiverKind;
  receiverRaw: string;
}

export interface SelectorInfo {
  selectorKind: SelectorKind;
  selector?: string;
  selectorExpression?: string;
}

export interface CallsiteFact extends LocatedFact, ReceiverInfo, SelectorInfo, InlineErrorContext {
  kind: "verb_call";
  argumentsText: string;
}

export interface FunctionCallFact extends LocatedFact, InlineErrorContext {
  kind: "function_call";
  function: string;
  argumentsText: string;
}

export interface ObjectRefFact extends LocatedFact {
  kind: "object_reference";
  object: string;
  context: ObjectRefContext;
}

export interface SystemObjectRefFact extends LocatedFact {
  kind: "system_object_ref";
  symbol: string;
  context: ObjectRefContext;
}

export type ObjectRefContext =
  | "verb_call_receiver"
  | "expression"
  | "argument"
  | "assignment_left"
  | "assignment_right"
  | "property_receiver"
  | "unknown";

export interface PropertyAccessFact extends LocatedFact, ReceiverInfo, InlineErrorContext {
  kind: "property_access" | "computed_property_access";
  accessKind: AccessKind;
  propertyKind: "static" | "computed";
  property?: string;
  propertyExpression?: string;
}

export interface AssignmentFact extends LocatedFact {
  kind: "assignment";
  assignmentKind: "statement" | "expression";
  leftText: string;
  rightText: string;
}

export interface LocalBindingFact extends LocatedFact {
  kind: "local_binding";
  variable: string;
  bindingKind: "literal_object" | "system_object" | "this";
  rightText: string;
  object?: string;
  symbol?: string;
}

export interface DestructuringBindingFact extends LocatedFact {
  kind: "destructuring_binding";
  variable: string;
  patternText: string;
  rightText: string;
}

export interface LoopBindingFact extends LocatedFact {
  kind: "loop_binding";
  variable: string;
  collectionText: string;
  collectionKind: "contents_property" | "unknown";
}

export interface BranchGuardFact extends LocatedFact {
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
}

export interface CommentFact extends LocatedFact {
  kind: "comment";
  text: string;
}

export interface ParseErrorFact extends LocatedFact {
  kind: "parse_error";
  message: string;
  errorText?: string;
  parentType?: string;
  sourceLine?: string;
}

export interface VerbMetricFact extends SourceMetadata {
  kind: "verb_metric";
  lineCount: number;
  nonBlankLineCount: number;
  statementCount: number;
  branchCount: number;
  loopCount: number;
  conditionalExpressionCount: number;
  logicalOperatorCount: number;
  tryCount: number;
  inlineErrorCount: number;
  maxControlFlowDepth: number;
  cyclomaticComplexity: number;
}

export interface IdentifierRefFact extends LocatedFact {
  kind: "identifier_ref";
  name: string;
  refContext: "read";
}

export interface StringLiteralFact extends LocatedFact {
  kind: "string_literal";
  value: string;
  rawText: string;
}

export interface ExtractedFacts {
  verbMetrics: VerbMetricFact[];
  identifierRefs: IdentifierRefFact[];
  stringLiterals: StringLiteralFact[];
  callsites: CallsiteFact[];
  functionCalls: FunctionCallFact[];
  objectRefs: ObjectRefFact[];
  systemObjectRefs: SystemObjectRefFact[];
  propertyAccesses: PropertyAccessFact[];
  assignments: AssignmentFact[];
  localBindings: LocalBindingFact[];
  destructuringBindings: DestructuringBindingFact[];
  loopBindings: LoopBindingFact[];
  branchGuards: BranchGuardFact[];
  comments: CommentFact[];
  parseErrors: ParseErrorFact[];
}
