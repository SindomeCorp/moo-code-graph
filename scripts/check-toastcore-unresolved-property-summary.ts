import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface UnresolvedPropertyAccessFinding {
  reason: string;
}

interface PropertySummarySnapshot {
  total: number;
  byReason: Record<string, number>;
}

const resolvedDir = resolve(process.argv[2] ?? "tmp/resolved-toastcore");
const expectedPath = resolve(process.argv[3] ?? "test/fixtures/toastcore-unresolved-property-summary.json");

async function main(): Promise<void> {
  const actualPath = resolve(resolvedDir, "findings/unresolved_property_accesses.jsonl");
  if (!existsSync(actualPath)) {
    console.error(`Missing unresolved property findings: ${actualPath}`);
    process.exit(2);
  }
  if (!existsSync(expectedPath)) {
    console.error(`Missing expected snapshot: ${expectedPath}`);
    process.exit(2);
  }

  const actual = summarize(await readJsonl<UnresolvedPropertyAccessFinding>(actualPath));
  const expected = JSON.parse(await readFile(expectedPath, "utf8")) as PropertySummarySnapshot;
  const diff = diffSummaries(expected, actual);

  console.log(
    JSON.stringify(
      {
        resolvedDir,
        expectedPath,
        expected,
        actual,
        issueCount: diff.length,
        issues: diff
      },
      null,
      2
    )
  );

  if (diff.length > 0) process.exit(1);
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function summarize(findings: UnresolvedPropertyAccessFinding[]): PropertySummarySnapshot {
  const byReason: Record<string, number> = {};
  for (const finding of findings) {
    byReason[finding.reason] = (byReason[finding.reason] ?? 0) + 1;
  }
  return { total: findings.length, byReason: sortRecord(byReason) };
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function diffSummaries(expected: PropertySummarySnapshot, actual: PropertySummarySnapshot): string[] {
  const issues: string[] = [];
  if (expected.total !== actual.total) {
    issues.push(`total expected ${expected.total}, actual ${actual.total}`);
  }

  const reasons = new Set([...Object.keys(expected.byReason), ...Object.keys(actual.byReason)]);
  for (const reason of [...reasons].sort()) {
    const expectedCount = expected.byReason[reason] ?? 0;
    const actualCount = actual.byReason[reason] ?? 0;
    if (expectedCount !== actualCount) {
      issues.push(`${reason} expected ${expectedCount}, actual ${actualCount}`);
    }
  }

  return issues;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
