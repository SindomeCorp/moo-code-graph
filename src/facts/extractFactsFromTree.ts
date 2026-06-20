import type {
  BranchGuardFact,
  SourceMetadata,
  ExtractedFacts,
  InlineErrorContext,
  IdentifierRefFact,
  ParseErrorFact,
  ReceiverInfo,
  StringLiteralFact,
  VerbMetricFact
} from "./types.js";
import type { MooSyntaxNode, MooTree } from "../parser/MooParser.js";
import { classifyReceiver } from "./classifyReceiver.js";
import { classifySelector } from "./classifySelector.js";
import { classifyReferenceContext } from "./context.js";
import { detectAccessKind } from "./detectAccessKind.js";
import { locationOf, nodeText } from "./nodeText.js";

export function extractFactsFromTree(tree: MooTree, source: string, meta: SourceMetadata): ExtractedFacts {
  const facts: ExtractedFacts = {
    verbMetrics: [verbMetricFact(tree.rootNode, source, meta)],
    identifierRefs: [],
    stringLiterals: [],
    callsites: [],
    functionCalls: [],
    objectRefs: [],
    systemObjectRefs: [],
    propertyAccesses: [],
    assignments: [],
    localBindings: [],
    destructuringBindings: [],
    loopBindings: [],
    branchGuards: [],
    comments: [],
    parseErrors: []
  };

  walk(tree.rootNode, (node) => {
    const controlFlow = controlFlowContext(node);
    if (node.type === "ERROR") {
      facts.parseErrors.push(parseErrorFact(node, source, meta, "Tree contains ERROR node"));
      return;
    }
    if (node.type === "identifier" && isIdentifierRead(node)) {
      facts.identifierRefs.push(identifierRefFact(node, source, meta, controlFlow));
    }
    if (isStringLiteralNode(node)) {
      facts.stringLiterals.push(stringLiteralFact(node, source, meta, controlFlow));
    }
    if (node.type === "verb_call") {
      const receiver = node.childForFieldName("receiver");
      const selector = node.childForFieldName("verb");
      const args = node.childForFieldName("arguments");
      facts.callsites.push({
        kind: "verb_call",
        ...meta,
        ...locationOf(node),
        ...controlFlow,
        ...inlineErrorContext(node, source, ["E_VERBNF", "ANY"]),
        ...classifyReceiver(receiver, source),
        ...classifySelector(selector, source),
        argumentsText: args ? nodeText(source, args) : ""
      });
    } else if (node.type === "function_call") {
      const fn = node.childForFieldName("function");
      const args = node.childForFieldName("arguments");
      facts.functionCalls.push({
        kind: "function_call",
        ...meta,
        ...locationOf(node),
        ...controlFlow,
        ...inlineErrorContext(node, source, ["E_VERBNF", "ANY"]),
        function: fn ? nodeText(source, fn) : "",
        argumentsText: args ? nodeText(source, args) : ""
      });
    } else if (node.type === "object_reference") {
      facts.objectRefs.push({
        kind: "object_reference",
        ...meta,
        ...locationOf(node),
        ...controlFlow,
        object: nodeText(source, node),
        context: classifyReferenceContext(node)
      });
    } else if (node.type === "system_object") {
      facts.systemObjectRefs.push({
        kind: "system_object_ref",
        ...meta,
        ...locationOf(node),
        ...controlFlow,
        symbol: nodeText(source, node),
        context: classifyReferenceContext(node)
      });
    } else if (node.type === "property_access" || node.type === "computed_property_access") {
      const receiver = node.childForFieldName("receiver");
      const property = node.childForFieldName("property");
      const computed = node.type === "computed_property_access";
      facts.propertyAccesses.push({
        kind: node.type,
        ...meta,
        ...locationOf(node),
        ...controlFlow,
        ...inlineErrorContext(node, source, ["E_PROPNF", "ANY"]),
        ...classifyReceiver(receiver, source),
        accessKind: detectAccessKind(node),
        propertyKind: computed ? "computed" : "static",
        ...(computed ? { propertyExpression: property ? nodeText(source, property) : "" } : { property: property ? nodeText(source, property) : "" })
      });
    } else if (node.type === "assignment_statement" || node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      const leftText = left ? nodeText(source, left) : "";
      const rightText = right ? nodeText(source, right) : "";
      facts.assignments.push({
        kind: "assignment",
        ...meta,
        ...locationOf(node),
        ...controlFlow,
        assignmentKind: node.type === "assignment_statement" ? "statement" : "expression",
        leftText,
        rightText
      });
      if (left?.type === "identifier" && right) {
        if (right.type === "object_reference") {
          facts.localBindings.push({
            kind: "local_binding",
            ...meta,
            ...locationOf(node),
            ...controlFlow,
            variable: leftText,
            bindingKind: "literal_object",
            rightText,
            object: rightText
          });
        } else if (right.type === "system_object") {
          facts.localBindings.push({
            kind: "local_binding",
            ...meta,
            ...locationOf(node),
            ...controlFlow,
            variable: leftText,
            bindingKind: "system_object",
            rightText,
            symbol: rightText
          });
        } else if (right.type === "identifier" && rightText.toLowerCase() === "this") {
          facts.localBindings.push({
            kind: "local_binding",
            ...meta,
            ...locationOf(node),
            ...controlFlow,
            variable: leftText,
            bindingKind: "this",
            rightText
          });
        }
      } else if (left?.type === "scatter_pattern") {
        const patternText = leftText;
        for (let index = 0; index < left.namedChildCount; index += 1) {
          const child = left.namedChild(index);
          if (child?.type !== "identifier") continue;
          facts.destructuringBindings.push({
            kind: "destructuring_binding",
            ...meta,
            ...locationOf(node),
            ...controlFlow,
            variable: nodeText(source, child),
            patternText,
            rightText
          });
        }
      }
    } else if (node.type === "for_statement") {
      const variable = node.childForFieldName("value") ?? node.namedChild(0);
      const collection = node.childForFieldName("collection") ?? node.namedChild(1);
      if (variable?.type === "identifier" && collection) {
        const collectionText = nodeText(source, collection);
        facts.loopBindings.push({
          kind: "loop_binding",
          ...meta,
          ...locationOf(node),
          ...controlFlow,
          variable: nodeText(source, variable),
          collectionText,
          collectionKind: isContentsProperty(collection, source) ? "contents_property" : "unknown"
        });
      }
    } else if (node.type === "conditional_expression") {
      const condition = node.namedChild(0);
      const positive = node.namedChild(1);
      if (condition && positive) {
        for (const guard of positiveHasPropertyGuards(condition, source)) {
          for (const access of matchingPropertyAccesses(positive, guard.receiver, guard.property, source)) {
            facts.branchGuards.push({
              kind: "branch_guard",
              ...meta,
              ...locationOf(guard.node),
              ...controlFlowContext(node),
              guardKind: "has_property",
              guardPolarity: "positive",
              guardScope: "conditional_expression",
              receiverKind: guard.receiver.receiverKind,
              receiverRaw: guard.receiver.receiverRaw,
              property: guard.property,
              guardedLine: access.startPosition.row,
              guardedColumn: access.startPosition.column,
              conditionText: nodeText(source, condition),
              guardText: nodeText(source, guard.node)
            });
          }
        }
        for (const guard of positiveHasVerbGuards(condition, source)) {
          for (const call of matchingVerbCalls(positive, guard.receiver, guard.verb, source)) {
            facts.branchGuards.push({
              kind: "branch_guard",
              ...meta,
              ...locationOf(guard.node),
              ...controlFlowContext(node),
              guardKind: guard.guardKind,
              guardPolarity: "positive",
              guardScope: "conditional_expression",
              receiverKind: guard.receiver.receiverKind,
              receiverRaw: guard.receiver.receiverRaw,
              verb: guard.verb,
              guardedLine: call.startPosition.row,
              guardedColumn: call.startPosition.column,
              conditionText: nodeText(source, condition),
              guardText: nodeText(source, guard.node)
            });
          }
        }
        for (const guard of positiveValidGuards(condition, source)) {
          for (const access of matchingReceiverPropertyAccesses(positive, guard.variable, source)) {
            facts.branchGuards.push(
              validBranchGuardFact(
                meta,
                guard,
                {
                  ...locationOf(guard.node),
                  ...controlFlowContext(node),
                  guardedLine: access.startPosition.row,
                  guardedColumn: access.startPosition.column
                },
                "positive",
                "conditional_expression",
                nodeText(source, condition),
                source
              )
            );
          }
        }
      }
    } else if (node.type === "if_statement" || node.type === "elseif_clause") {
      const condition = node.childForFieldName("condition");
      if (condition) {
        const guardControlFlow = branchGuardControlFlowContext(node);
        for (const guard of positiveIsaGuards(condition, source)) {
          facts.branchGuards.push({
            kind: "branch_guard",
            ...meta,
            ...locationOf(guard.node),
            ...guardControlFlow,
            guardKind: "isa",
            guardPolarity: "positive",
            guardScope: "branch",
            ...(guard.variable ? { variable: guard.variable } : {}),
            receiverKind: guard.receiver.receiverKind,
            receiverRaw: guard.receiver.receiverRaw,
            targetKind: guard.targetKind,
            targetRaw: guard.targetRaw,
            conditionText: nodeText(source, condition),
            guardText: nodeText(source, guard.node)
          });
        }
        for (const guard of positiveHasPropertyGuards(condition, source)) {
          facts.branchGuards.push(
            hasPropertyBranchGuardFact(
              meta,
              guard,
              { ...locationOf(guard.node), ...guardControlFlow },
              "positive",
              "branch",
              nodeText(source, condition),
              source
            )
          );
        }
        for (const guard of positiveHasVerbGuards(condition, source)) {
          facts.branchGuards.push(
            hasVerbBranchGuardFact(
              meta,
              guard,
              { ...locationOf(guard.node), ...guardControlFlow },
              "positive",
              "branch",
              nodeText(source, condition),
              source
            )
          );
        }
        for (const guard of positiveValidGuards(condition, source)) {
          facts.branchGuards.push(
            validBranchGuardFact(
              meta,
              guard,
              { ...locationOf(guard.node), ...guardControlFlow },
              "positive",
              "branch",
              nodeText(source, condition),
              source
            )
          );
        }
        for (const guard of negativeMatchFailureGuards(condition, source)) {
          facts.branchGuards.push(
            matchFailureBranchGuardFact(
              meta,
              guard,
              { ...locationOf(guard.node), ...guardControlFlow },
              "negative",
              "branch",
              nodeText(source, condition),
              source
            )
          );
        }
        if (node.type === "if_statement") {
          const negativeGuard = negativeIsaGuard(condition, source);
          const negativeHasProperty = negativeHasPropertyGuard(condition, source);
          const negativeHasVerb = negativeHasVerbGuard(condition, source);
          const negativeValid = negativeValidGuard(condition, source);
          const positiveMatchFailures = positiveMatchFailureGuards(condition, source);
          const terminalReturn = firstBranchTerminalReturn(node);
          if (negativeGuard && terminalReturn) {
            facts.branchGuards.push({
              kind: "branch_guard",
              ...meta,
              line: terminalReturn.endPosition.row,
              column: terminalReturn.endPosition.column,
              ...branchGuardControlFlowContext(node),
              guardKind: "isa",
              guardPolarity: "negative",
              guardScope: "sibling_continuation",
              terminalKind: "return",
              ...(negativeGuard.variable ? { variable: negativeGuard.variable } : {}),
              receiverKind: negativeGuard.receiver.receiverKind,
              receiverRaw: negativeGuard.receiver.receiverRaw,
              targetKind: negativeGuard.targetKind,
              targetRaw: negativeGuard.targetRaw,
              conditionText: nodeText(source, condition),
              guardText: nodeText(source, negativeGuard.node)
            });
            facts.branchGuards.push({
              kind: "branch_guard",
              ...meta,
              line: node.endPosition.row,
              column: node.endPosition.column,
              ...postIfContinuationControlFlowContext(node),
              guardKind: "isa",
              guardPolarity: "negative",
              guardScope: "post_continuation",
              terminalKind: "return",
              ...(negativeGuard.variable ? { variable: negativeGuard.variable } : {}),
              receiverKind: negativeGuard.receiver.receiverKind,
              receiverRaw: negativeGuard.receiver.receiverRaw,
              targetKind: negativeGuard.targetKind,
              targetRaw: negativeGuard.targetRaw,
              conditionText: nodeText(source, condition),
              guardText: nodeText(source, negativeGuard.node)
            });
          }
          if (negativeHasProperty && terminalReturn) {
            facts.branchGuards.push(
              hasPropertyBranchGuardFact(
                meta,
                negativeHasProperty,
                {
                  line: terminalReturn.endPosition.row,
                  column: terminalReturn.endPosition.column,
                  ...branchGuardControlFlowContext(node)
                },
                "negative",
                "sibling_continuation",
                nodeText(source, condition),
                source,
                "return"
              )
            );
            facts.branchGuards.push(
              hasPropertyBranchGuardFact(
                meta,
                negativeHasProperty,
                {
                  line: node.endPosition.row,
                  column: node.endPosition.column,
                  ...postIfContinuationControlFlowContext(node)
                },
                "negative",
                "post_continuation",
                nodeText(source, condition),
                source,
                "return"
              )
            );
          }
          if (negativeHasVerb && terminalReturn) {
            facts.branchGuards.push(
              hasVerbBranchGuardFact(
                meta,
                negativeHasVerb,
                {
                  line: terminalReturn.endPosition.row,
                  column: terminalReturn.endPosition.column,
                  ...branchGuardControlFlowContext(node)
                },
                "negative",
                "sibling_continuation",
                nodeText(source, condition),
                source,
                "return"
              )
            );
            facts.branchGuards.push(
              hasVerbBranchGuardFact(
                meta,
                negativeHasVerb,
                {
                  line: node.endPosition.row,
                  column: node.endPosition.column,
                  ...postIfContinuationControlFlowContext(node)
                },
                "negative",
                "post_continuation",
                nodeText(source, condition),
                source,
                "return"
              )
            );
          }
          if (negativeValid && terminalReturn) {
            facts.branchGuards.push(
              validBranchGuardFact(
                meta,
                negativeValid,
                {
                  line: terminalReturn.endPosition.row,
                  column: terminalReturn.endPosition.column,
                  ...branchGuardControlFlowContext(node)
                },
                "negative",
                "sibling_continuation",
                nodeText(source, condition),
                source,
                "return"
              )
            );
            facts.branchGuards.push(
              validBranchGuardFact(
                meta,
                negativeValid,
                {
                  line: node.endPosition.row,
                  column: node.endPosition.column,
                  ...postIfContinuationControlFlowContext(node)
                },
                "negative",
                "post_continuation",
                nodeText(source, condition),
                source,
                "return"
              )
            );
          }
          if (positiveMatchFailures.length > 0 && terminalReturn) {
            for (const guard of positiveMatchFailures) {
              facts.branchGuards.push(
                matchFailureBranchGuardFact(
                  meta,
                  guard,
                  {
                    line: terminalReturn.endPosition.row,
                    column: terminalReturn.endPosition.column,
                    ...branchGuardControlFlowContext(node)
                  },
                  "positive",
                  "sibling_continuation",
                  nodeText(source, condition),
                  source,
                  "return"
                )
              );
              facts.branchGuards.push(
                matchFailureBranchGuardFact(
                  meta,
                  guard,
                  {
                    line: node.endPosition.row,
                    column: node.endPosition.column,
                    ...postIfContinuationControlFlowContext(node)
                  },
                  "positive",
                  "post_continuation",
                  nodeText(source, condition),
                  source,
                  "return"
                )
              );
            }
          }
        }
      }
    } else if (node.type === "comment") {
      facts.comments.push({ kind: "comment", ...meta, ...locationOf(node), ...controlFlow, text: nodeText(source, node) });
    }
  });

  return facts;
}

function controlFlowContext(node: MooSyntaxNode): {
  controlFlowKind: "top_level" | "branch" | "loop" | "branch_loop";
  controlFlowDepth: number;
  controlFlowPath?: string[];
} {
  const path: string[] = [];
  let hasBranch = false;
  let hasLoop = false;
  let current = node.parent;
  while (current) {
    if (isBranchNode(current) || isLoopNode(current)) {
      if (isBranchNode(current)) hasBranch = true;
      if (isLoopNode(current)) hasLoop = true;
      path.unshift(`${current.type}@${current.startPosition.row}:${current.startPosition.column}-${current.endPosition.row}:${current.endPosition.column}`);
    }
    current = current.parent;
  }
  return {
    controlFlowKind: hasBranch && hasLoop ? "branch_loop" : hasBranch ? "branch" : hasLoop ? "loop" : "top_level",
    controlFlowDepth: path.length,
    ...(path.length > 0 ? { controlFlowPath: path } : {})
  };
}

function branchGuardControlFlowContext(node: MooSyntaxNode): {
  controlFlowKind: "branch" | "branch_loop";
  controlFlowDepth: number;
  controlFlowPath: string[];
} {
  const parent = controlFlowContext(node);
  const path = [...(parent.controlFlowPath ?? []), controlFlowSegment(node)];
  return {
    controlFlowKind: parent.controlFlowKind === "loop" || parent.controlFlowKind === "branch_loop" ? "branch_loop" : "branch",
    controlFlowDepth: path.length,
    controlFlowPath: path
  };
}

function postIfContinuationControlFlowContext(node: MooSyntaxNode): {
  controlFlowKind: "top_level" | "branch" | "loop" | "branch_loop";
  controlFlowDepth: number;
  controlFlowPath?: string[];
} {
  return controlFlowContextForAncestors(node.parent);
}

function controlFlowContextForAncestors(start: MooSyntaxNode | null): {
  controlFlowKind: "top_level" | "branch" | "loop" | "branch_loop";
  controlFlowDepth: number;
  controlFlowPath?: string[];
} {
  const path: string[] = [];
  let hasBranch = false;
  let hasLoop = false;
  let current = start;
  while (current) {
    if (isBranchNode(current) || isLoopNode(current)) {
      if (isBranchNode(current)) hasBranch = true;
      if (isLoopNode(current)) hasLoop = true;
      path.unshift(controlFlowSegment(current));
    }
    current = current.parent;
  }
  return {
    controlFlowKind: hasBranch && hasLoop ? "branch_loop" : hasBranch ? "branch" : hasLoop ? "loop" : "top_level",
    controlFlowDepth: path.length,
    ...(path.length > 0 ? { controlFlowPath: path } : {})
  };
}

function isBranchNode(node: MooSyntaxNode): boolean {
  return node.type === "if_statement" || node.type === "else_clause" || node.type === "elseif_clause";
}

function isLoopNode(node: MooSyntaxNode): boolean {
  return node.type === "for_statement" || node.type === "while_statement";
}

function inlineErrorContext(node: MooSyntaxNode, source: string, handledCodes: string[]): InlineErrorContext {
  let current = node.parent;
  while (current) {
    if (current.type === "inline_error_expression" && isInsideInlineErrorBody(current, node)) {
      const codes = inlineErrorCodes(current, source);
      const fallback = current.childForFieldName("fallback");
      const handledCodeSet = new Set(handledCodes.map((code) => code.toUpperCase()));
      const handled = codes.some((code) => {
        const normalized = code.toUpperCase();
        return handledCodeSet.has(normalized);
      });
      return {
        inlineErrorHandled: handled,
        inlineErrorCodes: codes,
        ...(fallback ? { inlineErrorFallbackText: nodeText(source, fallback) } : {}),
        inlineErrorExpressionText: nodeText(source, current)
      };
    }
    current = current.parent;
  }
  return {};
}

function isInsideInlineErrorBody(inlineError: MooSyntaxNode, node: MooSyntaxNode): boolean {
  const body = inlineError.childForFieldName("body");
  if (!body) return false;
  return node.startIndex >= body.startIndex && node.endIndex <= body.endIndex;
}

function inlineErrorCodes(inlineError: MooSyntaxNode, source: string): string[] {
  return inlineError
    .childrenForFieldName("errors")
    .filter((child) => child.type !== ",")
    .map((child) => nodeText(source, child).trim())
    .filter(Boolean);
}

function isContentsProperty(node: MooSyntaxNode, source: string): boolean {
  if (node.type !== "property_access") return false;
  const property = node.childForFieldName("property");
  return property ? nodeText(source, property).toLowerCase() === "contents" : false;
}

interface PositiveIsaGuard {
  node: MooSyntaxNode;
  receiver: ReceiverInfo;
  variable?: string;
  targetKind: "system_object" | "literal_object";
  targetRaw: string;
}

interface HasPropertyGuard {
  node: MooSyntaxNode;
  receiver: ReceiverInfo;
  property: string;
}

interface HasVerbGuard {
  node: MooSyntaxNode;
  guardKind: "has_callable_verb" | "has_verb";
  receiver: ReceiverInfo;
  verb: string;
}

interface ValidGuard {
  node: MooSyntaxNode;
  variable: string;
}

interface MatchFailureGuard {
  node: MooSyntaxNode;
  variable: string;
}

function positiveIsaGuards(condition: MooSyntaxNode, source: string): PositiveIsaGuard[] {
  const inlineBody = inlineErrorBody(condition);
  if (inlineBody) return positiveIsaGuards(inlineBody, source);

  if (condition.type === "parenthesized_expression" && condition.namedChildCount === 1) {
    return positiveIsaGuards(condition.namedChild(0)!, source);
  }

  if (condition.type === "binary_expression") {
    const operator = condition.children.find((child) => !child.isNamed);
    if (!operator || nodeText(source, operator) !== "&&") return [];
    return condition.namedChildren.flatMap((child) => positiveIsaGuards(child, source));
  }

  const direct = isaGuardFromCall(condition, source);
  return direct ? [direct] : [];
}

function positiveValidGuards(condition: MooSyntaxNode, source: string): ValidGuard[] {
  const inlineBody = inlineErrorBody(condition);
  if (inlineBody) return positiveValidGuards(inlineBody, source);

  if (condition.type === "parenthesized_expression" && condition.namedChildCount === 1) {
    return positiveValidGuards(condition.namedChild(0)!, source);
  }

  if (condition.type === "binary_expression") {
    const operator = condition.children.find((child) => !child.isNamed);
    if (!operator || nodeText(source, operator) !== "&&") return [];
    return condition.namedChildren.flatMap((child) => positiveValidGuards(child, source));
  }

  const direct = validGuardFromCall(condition, source);
  return direct ? [direct] : [];
}

function negativeIsaGuard(condition: MooSyntaxNode, source: string): PositiveIsaGuard | undefined {
  const inlineBody = inlineErrorBody(condition);
  if (inlineBody) return negativeIsaGuard(inlineBody, source);

  if (condition.type === "parenthesized_expression" && condition.namedChildCount === 1) {
    return negativeIsaGuard(condition.namedChild(0)!, source);
  }
  if (condition.type !== "unary_expression") return undefined;
  const operator = condition.children.find((child) => !child.isNamed);
  if (!operator || nodeText(source, operator) !== "!") return undefined;
  const operand = condition.namedChild(0);
  if (!operand) return undefined;
  if (operand.type === "parenthesized_expression" && operand.namedChildCount === 1) {
    return isaGuardFromCall(operand.namedChild(0)!, source);
  }
  return isaGuardFromCall(operand, source);
}

function negativeValidGuard(condition: MooSyntaxNode, source: string): ValidGuard | undefined {
  const inlineBody = inlineErrorBody(condition);
  if (inlineBody) return negativeValidGuard(inlineBody, source);

  if (condition.type === "parenthesized_expression" && condition.namedChildCount === 1) {
    return negativeValidGuard(condition.namedChild(0)!, source);
  }
  if (condition.type !== "unary_expression") return undefined;
  const operator = condition.children.find((child) => !child.isNamed);
  if (!operator || nodeText(source, operator) !== "!") return undefined;
  const operand = condition.namedChild(0);
  if (!operand) return undefined;
  if (operand.type === "parenthesized_expression" && operand.namedChildCount === 1) {
    return validGuardFromCall(operand.namedChild(0)!, source);
  }
  return validGuardFromCall(operand, source);
}

function positiveMatchFailureGuards(condition: MooSyntaxNode, source: string): MatchFailureGuard[] {
  if (condition.type === "parenthesized_expression" && condition.namedChildCount === 1) {
    return positiveMatchFailureGuards(condition.namedChild(0)!, source);
  }

  if (condition.type === "binary_expression") {
    const operator = condition.children.find((child) => !child.isNamed);
    if (!operator || nodeText(source, operator) !== "||") return [];
    return condition.namedChildren.flatMap((child) => positiveMatchFailureGuards(child, source));
  }

  const direct = matchFailureGuardFromCall(condition, source);
  return direct ? [direct] : [];
}

function negativeMatchFailureGuards(condition: MooSyntaxNode, source: string): MatchFailureGuard[] {
  if (condition.type === "parenthesized_expression" && condition.namedChildCount === 1) {
    return negativeMatchFailureGuards(condition.namedChild(0)!, source);
  }

  if (condition.type === "binary_expression") {
    const operator = condition.children.find((child) => !child.isNamed);
    if (!operator || nodeText(source, operator) !== "&&") return [];
    return condition.namedChildren.flatMap((child) => negativeMatchFailureGuards(child, source));
  }

  if (condition.type !== "unary_expression") return [];
  const operator = condition.children.find((child) => !child.isNamed);
  if (!operator || nodeText(source, operator) !== "!") return [];
  const operand = condition.namedChild(0);
  if (!operand) return [];
  const guard =
    operand.type === "parenthesized_expression" && operand.namedChildCount === 1
      ? matchFailureGuardFromCall(operand.namedChild(0)!, source)
      : matchFailureGuardFromCall(operand, source);
  return guard ? [guard] : [];
}

function positiveHasPropertyGuards(condition: MooSyntaxNode, source: string): HasPropertyGuard[] {
  const inlineBody = inlineErrorBody(condition);
  if (inlineBody) return positiveHasPropertyGuards(inlineBody, source);

  if (condition.type === "parenthesized_expression" && condition.namedChildCount === 1) {
    return positiveHasPropertyGuards(condition.namedChild(0)!, source);
  }

  if (condition.type === "binary_expression") {
    const operator = condition.children.find((child) => !child.isNamed);
    if (!operator || nodeText(source, operator) !== "&&") return [];
    return condition.namedChildren.flatMap((child) => positiveHasPropertyGuards(child, source));
  }

  const direct = hasPropertyGuardFromCall(condition, source);
  return direct ? [direct] : [];
}

function positiveHasVerbGuards(condition: MooSyntaxNode, source: string): HasVerbGuard[] {
  const inlineBody = inlineErrorBody(condition);
  if (inlineBody) return positiveHasVerbGuards(inlineBody, source);

  if (condition.type === "parenthesized_expression" && condition.namedChildCount === 1) {
    return positiveHasVerbGuards(condition.namedChild(0)!, source);
  }

  if (condition.type === "binary_expression") {
    const operator = condition.children.find((child) => !child.isNamed);
    if (!operator || nodeText(source, operator) !== "&&") return [];
    return condition.namedChildren.flatMap((child) => positiveHasVerbGuards(child, source));
  }

  const direct = hasVerbGuardFromCall(condition, source);
  return direct ? [direct] : [];
}

function negativeHasPropertyGuard(condition: MooSyntaxNode, source: string): HasPropertyGuard | undefined {
  const inlineBody = inlineErrorBody(condition);
  if (inlineBody) return negativeHasPropertyGuard(inlineBody, source);

  if (condition.type === "parenthesized_expression" && condition.namedChildCount === 1) {
    return negativeHasPropertyGuard(condition.namedChild(0)!, source);
  }
  if (condition.type !== "unary_expression") return undefined;
  const operator = condition.children.find((child) => !child.isNamed);
  if (!operator || nodeText(source, operator) !== "!") return undefined;
  const operand = condition.namedChild(0);
  if (!operand) return undefined;
  if (operand.type === "parenthesized_expression" && operand.namedChildCount === 1) {
    return hasPropertyGuardFromCall(operand.namedChild(0)!, source);
  }
  return hasPropertyGuardFromCall(operand, source);
}

function negativeHasVerbGuard(condition: MooSyntaxNode, source: string): HasVerbGuard | undefined {
  const inlineBody = inlineErrorBody(condition);
  if (inlineBody) return negativeHasVerbGuard(inlineBody, source);

  if (condition.type === "parenthesized_expression" && condition.namedChildCount === 1) {
    return negativeHasVerbGuard(condition.namedChild(0)!, source);
  }
  if (condition.type !== "unary_expression") return undefined;
  const operator = condition.children.find((child) => !child.isNamed);
  if (!operator || nodeText(source, operator) !== "!") return undefined;
  const operand = condition.namedChild(0);
  if (!operand) return undefined;
  if (operand.type === "parenthesized_expression" && operand.namedChildCount === 1) {
    return hasVerbGuardFromCall(operand.namedChild(0)!, source);
  }
  return hasVerbGuardFromCall(operand, source);
}

function validGuardFromCall(node: MooSyntaxNode, source: string): ValidGuard | undefined {
  if (node.type === "verb_call") {
    const receiver = node.childForFieldName("receiver");
    const selector = node.childForFieldName("verb");
    if (!receiver || !selector || selector.type !== "identifier") return undefined;
    if (nodeText(source, selector).toLowerCase() !== "valid") return undefined;
    if (receiver.type !== "system_object" || nodeText(source, receiver).toLowerCase() !== "$recycler") return undefined;
    return validGuardFromArguments(node, source);
  }

  if (node.type === "function_call") {
    const fn = node.childForFieldName("function");
    if (!fn || nodeText(source, fn).toLowerCase() !== "valid") return undefined;
    return validGuardFromArguments(node, source);
  }

  return undefined;
}

function validGuardFromArguments(node: MooSyntaxNode, source: string): ValidGuard | undefined {
  const args = node.childForFieldName("arguments");
  if (!args || args.namedChildCount < 1) return undefined;
  const variable = args.namedChild(0);
  if (!variable || variable.type !== "identifier") return undefined;
  return {
    node,
    variable: nodeText(source, variable)
  };
}

function matchFailureGuardFromCall(node: MooSyntaxNode, source: string): MatchFailureGuard | undefined {
  if (node.type !== "verb_call") return undefined;
  const receiver = node.childForFieldName("receiver");
  const selector = node.childForFieldName("verb");
  if (!receiver || !selector || selector.type !== "identifier") return undefined;
  if (receiver.type !== "system_object" || nodeText(source, receiver).toLowerCase() !== "$command_utils") return undefined;
  const selectorText = nodeText(source, selector).toLowerCase();
  if (selectorText !== "object_match_failed" && selectorText !== "player_match_failed") return undefined;

  const args = node.childForFieldName("arguments");
  if (!args || args.namedChildCount < 1) return undefined;
  const variable = variableFromMatchFailureArgument(args.namedChild(0), source);
  if (!variable) return undefined;
  return {
    node,
    variable
  };
}

function variableFromMatchFailureArgument(node: MooSyntaxNode | null, source: string): string | undefined {
  if (!node) return undefined;
  if (node.type === "parenthesized_expression" && node.namedChildCount === 1) {
    return variableFromMatchFailureArgument(node.namedChild(0), source);
  }
  if (node.type === "identifier") return nodeText(source, node);
  if (node.type === "assignment_expression") {
    const left = node.childForFieldName("left");
    if (left?.type === "identifier") return nodeText(source, left);
  }
  return undefined;
}

function isaGuardFromCall(node: MooSyntaxNode, source: string): PositiveIsaGuard | undefined {
  if (node.type === "verb_call") {
    const receiver = node.childForFieldName("receiver");
    const selector = node.childForFieldName("verb");
    if (!receiver || !selector || selector.type !== "identifier") return undefined;
    if (nodeText(source, selector).toLowerCase() !== "isa") return undefined;
    const receiverText = nodeText(source, receiver).toLowerCase();
    if (receiver.type !== "system_object" || (receiverText !== "$ou" && receiverText !== "$object_utils")) return undefined;
    return isaGuardFromArguments(node, source);
  }

  if (node.type === "function_call") {
    const fn = node.childForFieldName("function");
    if (!fn || nodeText(source, fn).toLowerCase() !== "isa") return undefined;
    return isaGuardFromArguments(node, source);
  }

  return undefined;
}

function hasPropertyGuardFromCall(node: MooSyntaxNode, source: string): HasPropertyGuard | undefined {
  if (node.type !== "verb_call") return undefined;
  const receiver = node.childForFieldName("receiver");
  const selector = node.childForFieldName("verb");
  if (!receiver || !selector || selector.type !== "identifier") return undefined;
  if (nodeText(source, selector).toLowerCase() !== "has_property") return undefined;
  const receiverText = nodeText(source, receiver).toLowerCase();
  if (receiver.type !== "system_object" || (receiverText !== "$ou" && receiverText !== "$object_utils")) return undefined;
  return hasPropertyGuardFromArguments(node, source);
}

function hasVerbGuardFromCall(node: MooSyntaxNode, source: string): HasVerbGuard | undefined {
  if (node.type !== "verb_call") return undefined;
  const receiver = node.childForFieldName("receiver");
  const selector = node.childForFieldName("verb");
  if (!receiver || !selector || selector.type !== "identifier") return undefined;
  const selectorText = nodeText(source, selector).toLowerCase();
  if (selectorText !== "has_callable_verb" && selectorText !== "has_verb") return undefined;
  const receiverText = nodeText(source, receiver).toLowerCase();
  if (receiver.type !== "system_object" || (receiverText !== "$ou" && receiverText !== "$object_utils")) return undefined;
  return hasVerbGuardFromArguments(node, selectorText, source);
}

function firstBranchTerminalReturn(ifStatement: MooSyntaxNode): MooSyntaxNode | undefined {
  const condition = ifStatement.childForFieldName("condition");
  const branchStatements: MooSyntaxNode[] = [];
  for (const child of ifStatement.namedChildren) {
    if (condition && child.id === condition.id) continue;
    if (child.type === "elseif_clause" || child.type === "else_clause") break;
    branchStatements.push(child);
  }
  return branchStatements.at(-1)?.type === "return_statement" ? branchStatements.at(-1) : undefined;
}

function isaGuardFromArguments(node: MooSyntaxNode, source: string): PositiveIsaGuard | undefined {
  const args = node.childForFieldName("arguments");
  if (!args || args.namedChildCount < 2) return undefined;
  const receiver = args.namedChild(0);
  const target = args.namedChild(1);
  if (!receiver || !target) return undefined;
  if (target.type !== "system_object" && target.type !== "object_reference") return undefined;
  const classifiedReceiver = classifyReceiver(receiver, source);
  if (!isGuardableReceiver(classifiedReceiver.receiverKind)) return undefined;
  return {
    node,
    receiver: classifiedReceiver,
    ...(classifiedReceiver.receiverKind === "variable" ? { variable: classifiedReceiver.receiverRaw } : {}),
    targetKind: target.type === "system_object" ? "system_object" : "literal_object",
    targetRaw: nodeText(source, target)
  };
}

function inlineErrorBody(condition: MooSyntaxNode): MooSyntaxNode | undefined {
  if (condition.type !== "inline_error_expression") return undefined;
  return condition.childForFieldName("body") ?? condition.namedChild(0) ?? undefined;
}

function hasPropertyGuardFromArguments(node: MooSyntaxNode, source: string): HasPropertyGuard | undefined {
  const args = node.childForFieldName("arguments");
  if (!args || args.namedChildCount < 2) return undefined;
  const receiver = args.namedChild(0);
  const property = args.namedChild(1);
  if (!receiver || !property || property.type !== "string") return undefined;
  const propertyName = stringLiteralValue(property, source);
  if (!propertyName) return undefined;
  const classifiedReceiver = classifyReceiver(receiver, source);
  if (!isGuardableReceiver(classifiedReceiver.receiverKind)) return undefined;
  return {
    node,
    receiver: classifiedReceiver,
    property: propertyName
  };
}

function hasVerbGuardFromArguments(node: MooSyntaxNode, guardKind: "has_callable_verb" | "has_verb", source: string): HasVerbGuard | undefined {
  const args = node.childForFieldName("arguments");
  if (!args || args.namedChildCount < 2) return undefined;
  const receiver = args.namedChild(0);
  const verb = args.namedChild(1);
  if (!receiver || !verb || verb.type !== "string") return undefined;
  const verbName = stringLiteralValue(verb, source);
  if (!verbName) return undefined;
  const classifiedReceiver = classifyReceiver(receiver, source);
  if (!isGuardableReceiver(classifiedReceiver.receiverKind)) return undefined;
  return {
    node,
    guardKind,
    receiver: classifiedReceiver,
    verb: verbName
  };
}

function stringLiteralValue(node: MooSyntaxNode, source: string): string | undefined {
  const raw = nodeText(source, node);
  if (raw.length < 2 || !raw.startsWith("\"") || !raw.endsWith("\"")) return undefined;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
}

function isGuardableReceiver(receiverKind: ReceiverInfo["receiverKind"]): boolean {
  return receiverKind === "this" || receiverKind === "literal_object" || receiverKind === "system_object" || receiverKind === "variable" || receiverKind === "property_access";
}

function matchingPropertyAccesses(node: MooSyntaxNode, receiver: ReceiverInfo, property: string, source: string): MooSyntaxNode[] {
  const matches: MooSyntaxNode[] = [];
  walk(node, (child) => {
    if (child.type !== "property_access") return;
    const childReceiver = child.childForFieldName("receiver");
    const childProperty = child.childForFieldName("property");
    if (!childReceiver || !childProperty) return;
    const classified = classifyReceiver(childReceiver, source);
    if (!sameGuardReceiver(classified, receiver)) return;
    if (nodeText(source, childProperty).toLowerCase() !== property.toLowerCase()) return;
    matches.push(child);
  });
  return matches;
}

function matchingVerbCalls(node: MooSyntaxNode, receiver: ReceiverInfo, verb: string, source: string): MooSyntaxNode[] {
  const matches: MooSyntaxNode[] = [];
  walk(node, (child) => {
    if (child.type !== "verb_call") return;
    const childReceiver = child.childForFieldName("receiver");
    const childVerb = child.childForFieldName("verb");
    if (!childReceiver || !childVerb || childVerb.type !== "identifier") return;
    const classified = classifyReceiver(childReceiver, source);
    if (!sameGuardReceiver(classified, receiver)) return;
    if (nodeText(source, childVerb).toLowerCase() !== verb.toLowerCase()) return;
    matches.push(child);
  });
  return matches;
}

function matchingReceiverPropertyAccesses(node: MooSyntaxNode, variable: string, source: string): MooSyntaxNode[] {
  const matches: MooSyntaxNode[] = [];
  walk(node, (child) => {
    if (child.type !== "property_access") return;
    const childReceiver = child.childForFieldName("receiver");
    if (!childReceiver) return;
    const classified = classifyReceiver(childReceiver, source);
    if (classified.receiverKind !== "variable") return;
    if (classified.receiverRaw.toLowerCase() !== variable.toLowerCase()) return;
    matches.push(child);
  });
  return matches;
}

function sameGuardReceiver(left: ReceiverInfo, right: ReceiverInfo): boolean {
  return left.receiverKind === right.receiverKind && left.receiverRaw.toLowerCase() === right.receiverRaw.toLowerCase();
}

function validBranchGuardFact(
  meta: SourceMetadata,
  guard: ValidGuard,
  locationAndFlow: Pick<BranchGuardFact, "line" | "column" | "controlFlowKind" | "controlFlowDepth" | "controlFlowPath"> & {
    guardedLine?: number;
    guardedColumn?: number;
  },
  guardPolarity: BranchGuardFact["guardPolarity"],
  guardScope: BranchGuardFact["guardScope"],
  conditionText: string,
  source: string,
  terminalKind?: "return"
): BranchGuardFact {
  return {
    kind: "branch_guard",
    ...meta,
    ...locationAndFlow,
    guardKind: "valid",
    guardPolarity,
    guardScope,
    ...(terminalKind ? { terminalKind } : {}),
    variable: guard.variable,
    conditionText,
    guardText: nodeText(source, guard.node)
  };
}

function matchFailureBranchGuardFact(
  meta: SourceMetadata,
  guard: MatchFailureGuard,
  locationAndFlow: Pick<BranchGuardFact, "line" | "column" | "controlFlowKind" | "controlFlowDepth" | "controlFlowPath">,
  guardPolarity: BranchGuardFact["guardPolarity"],
  guardScope: BranchGuardFact["guardScope"],
  conditionText: string,
  source: string,
  terminalKind?: "return"
): BranchGuardFact {
  return {
    kind: "branch_guard",
    ...meta,
    ...locationAndFlow,
    guardKind: "match_failure",
    guardPolarity,
    guardScope,
    ...(terminalKind ? { terminalKind } : {}),
    variable: guard.variable,
    conditionText,
    guardText: nodeText(source, guard.node)
  };
}

function hasPropertyBranchGuardFact(
  meta: SourceMetadata,
  guard: HasPropertyGuard,
  locationAndFlow: Pick<BranchGuardFact, "line" | "column" | "controlFlowKind" | "controlFlowDepth" | "controlFlowPath">,
  guardPolarity: BranchGuardFact["guardPolarity"],
  guardScope: BranchGuardFact["guardScope"],
  conditionText: string,
  source: string,
  terminalKind?: "return"
): BranchGuardFact {
  return {
    kind: "branch_guard",
    ...meta,
    ...locationAndFlow,
    guardKind: "has_property",
    guardPolarity,
    guardScope,
    ...(terminalKind ? { terminalKind } : {}),
    receiverKind: guard.receiver.receiverKind,
    receiverRaw: guard.receiver.receiverRaw,
    property: guard.property,
    conditionText,
    guardText: nodeText(source, guard.node)
  };
}

function hasVerbBranchGuardFact(
  meta: SourceMetadata,
  guard: HasVerbGuard,
  locationAndFlow: Pick<BranchGuardFact, "line" | "column" | "controlFlowKind" | "controlFlowDepth" | "controlFlowPath">,
  guardPolarity: BranchGuardFact["guardPolarity"],
  guardScope: BranchGuardFact["guardScope"],
  conditionText: string,
  source: string,
  terminalKind?: "return"
): BranchGuardFact {
  return {
    kind: "branch_guard",
    ...meta,
    ...locationAndFlow,
    guardKind: guard.guardKind,
    guardPolarity,
    guardScope,
    ...(terminalKind ? { terminalKind } : {}),
    receiverKind: guard.receiver.receiverKind,
    receiverRaw: guard.receiver.receiverRaw,
    verb: guard.verb,
    conditionText,
    guardText: nodeText(source, guard.node)
  };
}

function controlFlowSegment(node: MooSyntaxNode): string {
  return `${node.type}@${node.startPosition.row}:${node.startPosition.column}-${node.endPosition.row}:${node.endPosition.column}`;
}

function parseErrorFact(node: MooSyntaxNode, source: string, meta: SourceMetadata, message: string): ParseErrorFact {
  return {
    kind: "parse_error",
    ...meta,
    ...locationOf(node),
    message,
    errorText: nodeText(source, node),
    ...(node.parent ? { parentType: node.parent.type } : {}),
    sourceLine: source.split(/\r?\n/)[node.startPosition.row] ?? ""
  };
}

function identifierRefFact(
  node: MooSyntaxNode,
  source: string,
  meta: SourceMetadata,
  controlFlow: {
    controlFlowKind: "top_level" | "branch" | "loop" | "branch_loop";
    controlFlowDepth: number;
    controlFlowPath?: string[];
  }
): IdentifierRefFact {
  return {
    kind: "identifier_ref",
    ...meta,
    ...locationOf(node),
    ...controlFlow,
    name: nodeText(source, node),
    refContext: "read"
  };
}

function isIdentifierRead(node: MooSyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if ((parent.type === "assignment_statement" || parent.type === "assignment_expression") && parent.childForFieldName("left")?.id === node.id) {
    return false;
  }
  if (parent.type === "scatter_pattern") return false;
  if (parent.type === "for_statement" && (parent.childForFieldName("value")?.id === node.id || parent.namedChild(0)?.id === node.id)) return false;
  if (parent.type === "property_access" && parent.childForFieldName("property")?.id === node.id) return false;
  if (parent.type === "verb_call" && parent.childForFieldName("verb")?.id === node.id) return false;
  if (parent.type === "function_call" && parent.childForFieldName("function")?.id === node.id) return false;
  return true;
}

function stringLiteralFact(
  node: MooSyntaxNode,
  source: string,
  meta: SourceMetadata,
  controlFlow: {
    controlFlowKind: "top_level" | "branch" | "loop" | "branch_loop";
    controlFlowDepth: number;
    controlFlowPath?: string[];
  }
): StringLiteralFact {
  const rawText = nodeText(source, node);
  return {
    kind: "string_literal",
    ...meta,
    ...locationOf(node),
    ...controlFlow,
    value: unquoteStringLiteral(rawText),
    rawText
  };
}

function isStringLiteralNode(node: MooSyntaxNode): boolean {
  return node.type === "string" || node.type === "string_literal" || node.type === "quoted_string";
}

function unquoteStringLiteral(rawText: string): string {
  if (rawText.length >= 2 && rawText.startsWith("\"") && rawText.endsWith("\"")) return rawText.slice(1, -1);
  return rawText;
}

function verbMetricFact(root: MooSyntaxNode, source: string, meta: SourceMetadata): VerbMetricFact {
  const metrics = {
    statementCount: 0,
    branchCount: 0,
    loopCount: 0,
    conditionalExpressionCount: 0,
    logicalOperatorCount: 0,
    tryCount: 0,
    inlineErrorCount: 0,
    maxControlFlowDepth: 0
  };

  walk(root, (node) => {
    if (isStatementNode(node)) metrics.statementCount += 1;
    if (isComplexityBranchNode(node)) metrics.branchCount += 1;
    if (isLoopNode(node)) metrics.loopCount += 1;
    if (node.type === "conditional_expression") metrics.conditionalExpressionCount += 1;
    if (isTryNode(node)) metrics.tryCount += 1;
    if (node.type === "inline_error_expression") metrics.inlineErrorCount += 1;
    if (node.type === "binary_expression") metrics.logicalOperatorCount += logicalOperatorCount(node, source);
    metrics.maxControlFlowDepth = Math.max(metrics.maxControlFlowDepth, controlFlowContext(node).controlFlowDepth);
  });

  return {
    kind: "verb_metric",
    ...meta,
    lineCount: lineCount(source),
    nonBlankLineCount: nonBlankLineCount(source),
    ...metrics,
    cyclomaticComplexity:
      1 +
      metrics.branchCount +
      metrics.loopCount +
      metrics.conditionalExpressionCount +
      metrics.logicalOperatorCount +
      metrics.tryCount +
      metrics.inlineErrorCount
  };
}

function lineCount(source: string): number {
  if (source.length === 0) return 0;
  return source.split(/\r?\n/).length;
}

function nonBlankLineCount(source: string): number {
  return source.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function isStatementNode(node: MooSyntaxNode): boolean {
  return node.type.endsWith("_statement");
}

function isComplexityBranchNode(node: MooSyntaxNode): boolean {
  return node.type === "if_statement" || node.type === "elseif_clause";
}

function isTryNode(node: MooSyntaxNode): boolean {
  return node.type === "try_statement" || node.type === "try_except_statement" || node.type === "try_finally_statement";
}

function logicalOperatorCount(node: MooSyntaxNode, source: string): number {
  return node.children.filter((child) => !child.isNamed && (nodeText(source, child) === "&&" || nodeText(source, child) === "||")).length;
}

function walk(node: MooSyntaxNode, visit: (node: MooSyntaxNode) => void): void {
  visit(node);
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    if (child) walk(child, visit);
  }
}
