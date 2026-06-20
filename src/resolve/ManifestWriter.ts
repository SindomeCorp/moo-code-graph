import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtractManifest } from "@sindomecorp/toaststunt-db-extractor";

export interface ResolveManifestInput {
  outputDir: string;
  sourceGraphDir: string;
  sourceExtractDir: string;
  sourceExtractManifest?: ExtractManifest;
  sourceFactSchemaVersion?: string;
  startedAt: string;
  completedAt: string;
  pretty?: boolean;
}

export async function writeResolveManifest(input: ResolveManifestInput): Promise<void> {
  const manifest = {
    tool: "moo-code-graph",
    mode: "resolved-reference-edges",
    sourceGraphDir: input.sourceGraphDir,
    sourceExtractDir: input.sourceExtractDir,
    sourceSnapshotId: input.sourceExtractManifest?.snapshotId ?? "unknown",
    sourceFactSchemaVersion: input.sourceFactSchemaVersion ?? "unknown",
    resolutionSchemaVersion: "resolved-reference-edges/v5",
    startedAt: input.startedAt,
    completedAt: input.completedAt
  };
  await writeFile(join(input.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, input.pretty ? 2 : undefined)}\n`, "utf8");
}
