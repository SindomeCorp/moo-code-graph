import type { MooSyntaxNode } from "../parser/MooParser.js";
import type { AccessKind } from "./types.js";

export function detectAccessKind(node: MooSyntaxNode): AccessKind {
  const parent = node.parent;
  if (!parent) return "read";
  if ((parent.type === "assignment_statement" || parent.type === "assignment_expression") && parent.childForFieldName("left")?.id === node.id) {
    return "write";
  }
  return "read";
}
