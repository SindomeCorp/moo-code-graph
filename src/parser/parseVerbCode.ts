import { readFile } from "node:fs/promises";
import { MooParser, type MooTree } from "./MooParser.js";

export interface ParsedVerbCode {
  source: string;
  tree: MooTree;
}

export async function parseVerbCode(path: string, parser = new MooParser()): Promise<ParsedVerbCode> {
  const source = await readFile(path, "utf8");
  return { source, tree: parser.parse(source) };
}
