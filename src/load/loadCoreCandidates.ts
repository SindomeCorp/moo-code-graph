import { join } from "node:path";
import type { CoreCandidateRecord } from "@sindomecorp/toaststunt-db-extractor";
import { readJsonl } from "./JsonlReader.js";

export async function loadCoreCandidates(extractDir: string): Promise<CoreCandidateRecord[]> {
  return readJsonl<CoreCandidateRecord>(join(extractDir, "core_candidates.jsonl"));
}
