import type { MooSyntaxNode } from "../parser/MooParser.js";
import type { ObjectRefContext } from "./types.js";

export function classifyReferenceContext(node: MooSyntaxNode): ObjectRefContext {
  const parent = node.parent;
  if (!parent) return "unknown";
  if (parent.type === "verb_call" && parent.childForFieldName("receiver")?.id === node.id) return "verb_call_receiver";
  if ((parent.type === "assignment_statement" || parent.type === "assignment_expression") && parent.childForFieldName("left")?.id === node.id) {
    return "assignment_left";
  }
  if ((parent.type === "assignment_statement" || parent.type === "assignment_expression") && parent.childForFieldName("right")?.id === node.id) {
    return "assignment_right";
  }
  if ((parent.type === "property_access" || parent.type === "computed_property_access") && parent.childForFieldName("receiver")?.id === node.id) {
    return "property_receiver";
  }
  if (parent.type === "argument_list") return "argument";
  return "expression";
}
