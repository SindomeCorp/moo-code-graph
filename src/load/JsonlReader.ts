import { readFile } from "node:fs/promises";

export async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  const records: T[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch (cause) {
      throw new Error(`Invalid JSONL in ${path} at line ${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return records;
}
