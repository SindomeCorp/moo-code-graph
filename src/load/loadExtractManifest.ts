import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtractManifest } from "@sindomecorp/toaststunt-db-extractor";

export async function loadExtractManifest(extractDir: string): Promise<ExtractManifest> {
  return JSON.parse(await readFile(join(extractDir, "manifest.json"), "utf8")) as ExtractManifest;
}
