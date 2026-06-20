import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { reportCoverage } from "../src/report/reportCoverage.js";

interface CoverageSummarySnapshot {
  rawStats: Record<string, number>;
  resolvedStats: Record<string, number>;
  unresolvedVerbCallsByReason: Record<string, number>;
  unresolvedPropertyAccessesByReason: Record<string, number>;
  definiteIssueCounts: {
    verbCalls: number;
    propertyAccesses: number;
  };
}

const resolvedDir = resolve(process.argv[2] ?? "tmp/resolved-toastcore");
const expectedPath = resolve(process.argv[3] ?? "test/fixtures/toastcore-coverage-summary.json");

async function main(): Promise<void> {
  const report = await reportCoverage({ resolvedDir });
  const actual: CoverageSummarySnapshot = {
    rawStats: numericRecord(report.rawStats),
    resolvedStats: numericRecord(report.resolvedStats),
    unresolvedVerbCallsByReason: Object.fromEntries(report.unresolvedVerbCallsByReason.map((group) => [group.reason, group.count])),
    unresolvedPropertyAccessesByReason: Object.fromEntries(report.unresolvedPropertyAccessesByReason.map((group) => [group.reason, group.count])),
    definiteIssueCounts: report.definiteIssueCounts
  };
  const expected = JSON.parse(await readFile(expectedPath, "utf8")) as CoverageSummarySnapshot;
  if (stableJson(actual) !== stableJson(expected)) {
    console.error(
      JSON.stringify(
        {
          message: "ToastCore coverage summary changed",
          resolvedDir,
          expectedPath,
          actual
        },
        null,
        2
      )
    );
    process.exit(1);
  }
  console.log(JSON.stringify({ resolvedDir, expectedPath, ...actual }, null, 2));
}

function numericRecord(input: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
