import { join } from "node:path";
import type { ExtractedPropertyValueRecord } from "@sindomecorp/toaststunt-db-extractor";
import { readJsonl } from "./JsonlReader.js";

export async function loadPropertyValues(extractDir: string): Promise<ExtractedPropertyValueRecord[]> {
  return readJsonl<ExtractedPropertyValueRecord>(join(extractDir, "property_values.jsonl"));
}
