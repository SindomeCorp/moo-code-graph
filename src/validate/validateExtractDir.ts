import { access, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import type { ExtractedVerbRecord } from "@sindomecorp/toaststunt-db-extractor";
import { readJsonl } from "../load/JsonlReader.js";

export interface ValidationIssue {
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export async function validateExtractDir(extractDir: string): Promise<ValidationResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  for (const required of ["manifest.json", "verbs.jsonl"]) {
    await requireReadable(join(extractDir, required), errors);
  }
  const verbCodeDir = join(extractDir, "verb_code");
  try {
    const info = await stat(verbCodeDir);
    if (!info.isDirectory()) errors.push({ message: "verb_code is not a directory", path: verbCodeDir });
  } catch {
    errors.push({ message: "Missing verb_code directory", path: verbCodeDir });
  }

  for (const jsonl of ["objects.jsonl", "verbs.jsonl", "properties.jsonl", "property_values.jsonl", "core_candidates.jsonl"]) {
    try {
      await validateJsonlParseable(join(extractDir, jsonl));
    } catch (cause) {
      errors.push({ message: cause instanceof Error ? cause.message : String(cause), path: join(extractDir, jsonl) });
    }
  }

  let verbs: ExtractedVerbRecord[] = [];
  try {
    verbs = await readJsonl<ExtractedVerbRecord>(join(extractDir, "verbs.jsonl"));
  } catch {
    return { valid: false, errors, warnings };
  }

  const ids = new Set<string>();
  const sourcePaths = new Set<string>();
  for (const verb of verbs) {
    if (ids.has(verb.id)) errors.push({ message: `Duplicate verb id ${verb.id}` });
    ids.add(verb.id);
    if (!verb.hasProgram || !verb.sourcePath) continue;
    if (sourcePaths.has(verb.sourcePath)) errors.push({ message: `Duplicate programmed verb sourcePath ${verb.sourcePath}` });
    sourcePaths.add(verb.sourcePath);
    await requireReadable(join(extractDir, verb.sourcePath), errors);
  }

  return { valid: errors.length === 0, errors, warnings };
}

async function validateJsonlParseable(path: string): Promise<void> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
      } catch (cause) {
        throw new Error(`Invalid JSONL in ${path} at line ${lineNumber}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function requireReadable(path: string, errors: ValidationIssue[]): Promise<void> {
  try {
    await access(path);
  } catch {
    errors.push({ message: "Missing or unreadable required file", path });
  }
}
