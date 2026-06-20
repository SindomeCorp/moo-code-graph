import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface UnresolvedRef {
  kind: "unresolved_ref";
  sourceVerbId: string;
  sourceVerbName?: string;
  sourceObject: string;
  sourcePath: string;
  line: number;
  column: number;
  refKind: string;
  ref: string;
  reason: string;
  receiverRaw?: string;
  receiverObject?: string;
  selector?: string;
  selectorExpression?: string;
  context?: string;
}

interface GroupSummary {
  key: string;
  count: number;
  examples: Array<{
    ref: string;
    reason: string;
    sourceVerbId: string;
    sourceVerbName?: string;
    sourcePath: string;
    line: number;
    column: number;
    receiverObject?: string;
    selector?: string;
  }>;
}

interface Args {
  resolvedDir: string;
  top: number;
}

const args = parseArgs(process.argv.slice(2));

async function main(): Promise<void> {
  const unresolvedPath = join(args.resolvedDir, "edges", "unresolved_refs.jsonl");
  if (!existsSync(unresolvedPath)) {
    console.error(`Missing unresolved refs file: ${unresolvedPath}`);
    process.exit(2);
  }

  const unresolved = await readJsonl<UnresolvedRef>(unresolvedPath);
  const verbCalls = unresolved.filter((ref) => ref.refKind === "verb_call");
  const systemObjects = unresolved.filter((ref) => ref.refKind === "system_object");
  const literalObjects = unresolved.filter((ref) => ref.refKind === "literal_object");

  const report = {
    resolvedDir: args.resolvedDir,
    totalUnresolvedCount: unresolved.length,
    unresolvedByRefKind: countBy(unresolved, (ref) => ref.refKind),
    unresolvedByReason: countBy(unresolved, (ref) => ref.reason),
    verbCalls: {
      count: verbCalls.length,
      byReason: countBy(verbCalls, (ref) => ref.reason),
      topRefs: topGroups(verbCalls, (ref) => ref.ref),
      topSymbols: topGroups(verbCalls.filter((ref) => ref.receiverRaw?.startsWith("$")), (ref) => ref.receiverRaw ?? "unknown"),
      topReceiverObjects: topGroups(verbCalls, (ref) => ref.receiverObject ?? "unknown"),
      topSelectors: topGroups(verbCalls, (ref) => ref.selector ?? ref.selectorExpression ?? "unknown"),
      topSources: topGroups(verbCalls, (ref) => ref.sourceVerbId)
    },
    systemObjects: {
      count: systemObjects.length,
      byReason: countBy(systemObjects, (ref) => ref.reason),
      topSymbols: topGroups(systemObjects, (ref) => ref.ref),
      missingTargetObjects: topGroups(
        systemObjects.filter((ref) => ref.reason === "core_candidate_missing_target_object"),
        (ref) => ref.receiverObject ?? "unknown"
      )
    },
    literalObjects: {
      count: literalObjects.length,
      byReason: countBy(literalObjects, (ref) => ref.reason),
      topObjects: topGroups(literalObjects, (ref) => ref.ref)
    }
  };

  console.log(JSON.stringify(report, null, 2));
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let top = 20;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--top") {
      const value = argv[index + 1];
      if (!value || Number.isNaN(Number(value))) {
        console.error("Usage: npm run analyze:unresolved -- <resolved-dir> [--top <count>]");
        process.exit(2);
      }
      top = Number(value);
      index += 1;
      continue;
    }
    positional.push(arg);
  }

  if (!positional[0]) {
    console.error("Usage: npm run analyze:unresolved -- <resolved-dir> [--top <count>]");
    process.exit(2);
  }

  return { resolvedDir: resolve(positional[0]), top };
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function countBy(rows: UnresolvedRef[], keyFn: (row: UnresolvedRef) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = keyFn(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1]));
}

function topGroups(rows: UnresolvedRef[], keyFn: (row: UnresolvedRef) => string): GroupSummary[] {
  const groups = new Map<string, UnresolvedRef[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      count: group.length,
      examples: group.slice(0, 5).map((row) => ({
        ref: row.ref,
        reason: row.reason,
        sourceVerbId: row.sourceVerbId,
        ...(row.sourceVerbName ? { sourceVerbName: row.sourceVerbName } : {}),
        sourcePath: row.sourcePath,
        line: row.line,
        column: row.column,
        ...(row.receiverObject ? { receiverObject: row.receiverObject } : {}),
        ...(row.selector ? { selector: row.selector } : {})
      }))
    }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, args.top);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
