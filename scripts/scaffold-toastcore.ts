import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { extractToastStuntDb } from "@sindomecorp/toaststunt-db-extractor";
import { indexMooCodeGraph, validateExtractDir } from "../src/index.js";

const repoUrl = process.env.TOASTCORE_REPO_URL ?? "https://github.com/lisdude/toastcore/";
const repoRef = process.env.TOASTCORE_REF;
const tmpDir = resolve("tmp");
const repoDir = resolve("tmp/toastcore");
const extractDir = resolve("tmp/extract-toastcore");
const graphDir = resolve("tmp/graph-toastcore");
const refresh = process.argv.includes("--refresh");

async function main(): Promise<void> {
  await mkdir(tmpDir, { recursive: true });
  await ensureToastCoreRepo();

  const dbPath = join(repoDir, "toastcore.db");
  if (!existsSync(dbPath)) {
    throw new Error(`Expected ToastCore DB at ${dbPath}`);
  }

  console.log(`Extracting ${dbPath}`);
  await extractToastStuntDb({
    inputPath: dbPath,
    outputDir: extractDir,
    overwrite: true,
    includeVerbCode: true,
    quiet: true
  });

  const validation = await validateExtractDir(extractDir);
  if (!validation.valid) {
    console.error(JSON.stringify(validation, null, 2));
    throw new Error("ToastCore extractor output failed validation");
  }

  console.log(`Indexing ${extractDir}`);
  const result = await indexMooCodeGraph({
    extractDir,
    outputDir: graphDir,
    overwrite: true,
    quiet: true
  });

  console.log(JSON.stringify({ extractDir, graphDir, stats: result.stats }, null, 2));
  if (result.stats.parseErrorCount !== 0) {
    printParseErrorSamples();
    throw new Error(`ToastCore produced ${result.stats.parseErrorCount} Tree-sitter parse errors`);
  }
}

async function ensureToastCoreRepo(): Promise<void> {
  if (refresh && existsSync(repoDir)) {
    await rm(repoDir, { recursive: true, force: true });
  }

  if (!existsSync(repoDir)) {
    const args = ["clone", "--depth", "1"];
    if (repoRef) args.push("--branch", repoRef);
    args.push(repoUrl, repoDir);
    run("git", args);
    return;
  }

  console.log(`Updating ${repoDir}`);
  run("git", ["-C", repoDir, "fetch", "--depth", "1", "origin"]);
  run("git", ["-C", repoDir, "pull", "--ff-only"]);
}

function printParseErrorSamples(): void {
  const path = join(graphDir, "code_facts/parse_errors.jsonl");
  if (!existsSync(path)) return;
  const result = spawnSync("head", ["-20", path], { encoding: "utf8" });
  if (result.stdout.trim()) {
    console.error("First parse errors:");
    console.error(result.stdout.trim());
  }
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
