import { join } from "node:path";
import type { ExtractedPropertyDefinitionRecord } from "@sindomecorp/toaststunt-db-extractor";
import { readJsonl } from "./JsonlReader.js";

export async function loadProperties(extractDir: string): Promise<ExtractedPropertyDefinitionRecord[]> {
  return readJsonl<ExtractedPropertyDefinitionRecord>(join(extractDir, "properties.jsonl"));
}
