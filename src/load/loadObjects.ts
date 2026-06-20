import { join } from "node:path";
import type { ExtractedObjectRecord } from "@sindomecorp/toaststunt-db-extractor";
import { readJsonl } from "./JsonlReader.js";

export async function loadObjects(extractDir: string): Promise<ExtractedObjectRecord[]> {
  return readJsonl<ExtractedObjectRecord>(join(extractDir, "objects.jsonl"));
}
