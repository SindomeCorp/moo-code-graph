import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtractedObjectRecord, ExtractedVerbRecord } from "@sindomecorp/toaststunt-db-extractor";
import { readJsonl } from "../load/JsonlReader.js";
import { loadExtractManifest } from "../load/loadExtractManifest.js";
import { loadCoreCandidates } from "../load/loadCoreCandidates.js";

export interface InspectResult {
  extractDir: string;
  snapshotId?: string;
  verbCount: number;
  programmedVerbCount: number;
  verbCodeFileCount: number;
  objectsCount?: number;
  coreCandidateCount?: number;
  missingSourceFiles: string[];
}

export async function inspectExtractDir(extractDir: string): Promise<InspectResult> {
  const manifest = await loadExtractManifest(extractDir);
  const verbs = await readJsonl<ExtractedVerbRecord>(join(extractDir, "verbs.jsonl"));
  const programmed = verbs.filter((verb) => verb.hasProgram && verb.sourcePath);
  const missingSourceFiles: string[] = [];
  const files = await readdir(join(extractDir, "verb_code")).catch(() => []);
  for (const verb of programmed) {
    try {
      await access(join(extractDir, verb.sourcePath!));
    } catch {
      missingSourceFiles.push(verb.sourcePath!);
    }
  }

  let objectsCount: number | undefined;
  try {
    objectsCount = (await readJsonl<ExtractedObjectRecord>(join(extractDir, "objects.jsonl"))).length;
  } catch {
    objectsCount = undefined;
  }

  let coreCandidateCount: number | undefined;
  try {
    coreCandidateCount = (await loadCoreCandidates(extractDir)).length;
  } catch {
    coreCandidateCount = undefined;
  }

  return {
    extractDir,
    snapshotId: manifest.snapshotId,
    verbCount: verbs.length,
    programmedVerbCount: programmed.length,
    verbCodeFileCount: files.filter((file) => file.endsWith(".moo")).length,
    ...(objectsCount !== undefined ? { objectsCount } : {}),
    ...(coreCandidateCount !== undefined ? { coreCandidateCount } : {}),
    missingSourceFiles
  };
}
