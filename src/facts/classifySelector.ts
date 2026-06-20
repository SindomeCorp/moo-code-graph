import type { MooSyntaxNode } from "../parser/MooParser.js";
import { nodeText } from "./nodeText.js";
import type { SelectorInfo } from "./types.js";

export function classifySelector(node: MooSyntaxNode | null, source: string): SelectorInfo {
  if (!node) return { selectorKind: "unknown" };
  const text = nodeText(source, node);
  if (node.type === "identifier") return { selectorKind: "static", selector: text };
  return { selectorKind: "dynamic", selectorExpression: unwrapDynamicSelector(text) };
}

function unwrapDynamicSelector(text: string): string {
  if (text.startsWith("(") && text.endsWith(")")) return text.slice(1, -1);
  return text;
}
