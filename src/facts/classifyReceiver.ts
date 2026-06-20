import type { MooSyntaxNode } from "../parser/MooParser.js";
import { nodeText } from "./nodeText.js";
import type { ReceiverInfo } from "./types.js";

export function classifyReceiver(node: MooSyntaxNode | null, source: string): ReceiverInfo {
  if (!node) return { receiverKind: "unknown", receiverRaw: "" };
  const text = nodeText(source, node);
  const lower = text.toLowerCase();
  if (lower === "this") return { receiverKind: "this", receiverRaw: text };
  if (lower === "player") return { receiverKind: "player", receiverRaw: text };
  if (lower === "caller") return { receiverKind: "caller", receiverRaw: text };
  if (node.type === "object_reference") return { receiverKind: "literal_object", receiverRaw: text };
  if (node.type === "system_object") return { receiverKind: "system_object", receiverRaw: text };
  if (node.type === "identifier") return { receiverKind: "variable", receiverRaw: text };
  if (node.type === "property_access") return { receiverKind: "property_access", receiverRaw: text };
  if (node.type === "computed_property_access") return { receiverKind: "computed_property_access", receiverRaw: text };
  return { receiverKind: "expression", receiverRaw: text };
}
