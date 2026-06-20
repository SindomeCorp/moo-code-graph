import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtractManifest } from "@sindomecorp/toaststunt-db-extractor";

export interface CodeGraphManifestInput {
  outputDir: string;
  sourceExtractDir: string;
  sourceManifest?: ExtractManifest;
  startedAt: string;
  completedAt: string;
  pretty?: boolean;
}

export async function writeManifest(input: CodeGraphManifestInput): Promise<void> {
  const manifest = {
    sourceExtractDir: input.sourceExtractDir,
    sourceSnapshotId: input.sourceManifest?.snapshotId ?? "unknown",
    indexerVersion: "0.1.0",
    factSchemaVersion: "raw-code-facts/v7",
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    tool: "moo-code-graph",
    mode: "raw-code-facts"
  };
  await writeFile(join(input.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, input.pretty ? 2 : undefined)}\n`, "utf8");
}
