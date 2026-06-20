import { join } from "node:path";
import type { ExtractedVerbRecord } from "@sindomecorp/toaststunt-db-extractor";
import { readJsonl } from "./JsonlReader.js";

export async function loadVerbs(extractDir: string): Promise<ExtractedVerbRecord[]> {
  return readJsonl<ExtractedVerbRecord>(join(extractDir, "verbs.jsonl"));
}
