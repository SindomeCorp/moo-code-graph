import type { MooSyntaxNode } from "../parser/MooParser.js";

export function nodeText(source: string, node: MooSyntaxNode): string {
  return source.slice(node.startIndex, node.endIndex);
}

export function locationOf(node: MooSyntaxNode): { line: number; column: number } {
  return { line: node.startPosition.row, column: node.startPosition.column };
}
