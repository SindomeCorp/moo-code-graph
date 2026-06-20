import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface UnresolvedVerbCallFinding {
  ref: string;
  reason: string;
  receiverObject?: string;
  candidateObjects?: string[];
  compositionKind?: "feature_list_hook";
  optionalHookHandled?: boolean;
  sourceVerbId: string;
  sourceVerbName: string;
  sourcePath: string;
  sourceLine?: string;
  line: number;
  column: number;
}

const resolvedDir = resolve(process.argv[2] ?? "tmp/resolved-toastcore");
const expectedPath = resolve(process.argv[3] ?? "test/fixtures/toastcore-unresolved-verb-calls.json");

async function main(): Promise<void> {
  const actualPath = resolve(resolvedDir, "findings/unresolved_verb_calls.jsonl");
  if (!existsSync(actualPath)) {
    console.error(`Missing unresolved verb-call findings: ${actualPath}`);
    process.exit(2);
  }
  if (!existsSync(expectedPath)) {
    console.error(`Missing expected snapshot: ${expectedPath}`);
    process.exit(2);
  }

  const actual = canonicalize(await readJsonl<UnresolvedVerbCallFinding>(actualPath));
  const expected = canonicalize(JSON.parse(await readFile(expectedPath, "utf8")) as UnresolvedVerbCallFinding[]);

  const actualKeys = new Set(actual.map(findingKey));
  const expectedKeys = new Set(expected.map(findingKey));
  const added = actual.filter((finding) => !expectedKeys.has(findingKey(finding)));
  const removed = expected.filter((finding) => !actualKeys.has(findingKey(finding)));

  console.log(
    JSON.stringify(
      {
        resolvedDir,
        expectedPath,
        expectedCount: expected.length,
        actualCount: actual.length,
        addedCount: added.length,
        removedCount: removed.length,
        added: added.slice(0, 25),
        removed: removed.slice(0, 25)
      },
      null,
      2
    )
  );

  if (added.length > 0 || removed.length > 0) {
    process.exit(1);
  }
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function canonicalize(findings: UnresolvedVerbCallFinding[]): UnresolvedVerbCallFinding[] {
  return findings
    .map((finding) => ({
      ref: finding.ref,
      reason: finding.reason,
      ...(finding.receiverObject ? { receiverObject: finding.receiverObject } : {}),
      ...(finding.candidateObjects ? { candidateObjects: finding.candidateObjects } : {}),
      ...(finding.compositionKind ? { compositionKind: finding.compositionKind } : {}),
      ...(finding.optionalHookHandled !== undefined ? { optionalHookHandled: finding.optionalHookHandled } : {}),
      sourceVerbId: finding.sourceVerbId,
      sourceVerbName: finding.sourceVerbName,
      sourcePath: finding.sourcePath,
      ...(finding.sourceLine ? { sourceLine: finding.sourceLine } : {}),
      line: finding.line,
      column: finding.column
    }))
    .sort((left, right) => findingKey(left).localeCompare(findingKey(right)));
}

function findingKey(finding: UnresolvedVerbCallFinding): string {
  return [
    finding.ref,
    finding.reason,
    finding.receiverObject ?? "",
    (finding.candidateObjects ?? []).join(","),
    finding.compositionKind ?? "",
    finding.optionalHookHandled === undefined ? "" : String(finding.optionalHookHandled),
    finding.sourceVerbId,
    finding.sourceVerbName,
    finding.sourcePath,
    finding.line,
    finding.column,
    finding.sourceLine ?? ""
  ].join("\t");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
