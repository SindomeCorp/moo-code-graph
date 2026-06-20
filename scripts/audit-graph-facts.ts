import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

interface AuditIssue {
  file: string;
  line?: number;
  message: string;
}

const graphDir = resolve(process.argv[2] ?? "");

if (!process.argv[2]) {
  console.error("Usage: npm run audit:graph -- <graph-dir>");
  process.exit(2);
}

const factFiles = {
  callsites: "code_facts/callsites.jsonl",
  functionCalls: "code_facts/function_calls.jsonl",
  objectRefs: "code_facts/object_refs.jsonl",
  systemObjectRefs: "code_facts/system_object_refs.jsonl",
  propertyAccesses: "code_facts/property_accesses.jsonl",
  assignments: "code_facts/assignments.jsonl",
  localBindings: "code_facts/local_bindings.jsonl",
  destructuringBindings: "code_facts/destructuring_bindings.jsonl",
  loopBindings: "code_facts/loop_bindings.jsonl",
  branchGuards: "code_facts/branch_guards.jsonl",
  comments: "code_facts/comments.jsonl",
  parseErrors: "code_facts/parse_errors.jsonl"
} as const;

const issues: AuditIssue[] = [];
const counts: Record<string, number> = {};

async function main(): Promise<void> {
  requireFile("manifest.json");
  requireFile("code_facts/stats.json");
  for (const file of Object.values(factFiles)) requireFile(file);

  const stats = await readJson(join(graphDir, "code_facts/stats.json"));

  await auditJsonl(factFiles.callsites, (row) => {
    requireKind(row, "verb_call");
    requireSource(row);
    requireString(row, "receiverKind");
    requireString(row, "receiverRaw");
    requireString(row, "selectorKind");
    requireString(row, "argumentsText");
    if (row.selectorKind === "static") requireString(row, "selector");
    if (row.selectorKind === "dynamic") requireString(row, "selectorExpression");
  });

  await auditJsonl(factFiles.functionCalls, (row) => {
    requireKind(row, "function_call");
    requireSource(row);
    requireString(row, "function");
    requireString(row, "argumentsText");
  });

  await auditJsonl(factFiles.objectRefs, (row) => {
    requireKind(row, "object_reference");
    requireSource(row);
    requireString(row, "object");
    requireString(row, "context");
  });

  await auditJsonl(factFiles.systemObjectRefs, (row) => {
    requireKind(row, "system_object_ref");
    requireSource(row);
    requireString(row, "symbol");
    requireString(row, "context");
  });

  await auditJsonl(factFiles.propertyAccesses, (row) => {
    if (row.kind !== "property_access" && row.kind !== "computed_property_access") {
      issues.push({ file: currentFile, line: currentLine, message: `Unexpected property access kind ${String(row.kind)}` });
    }
    requireSource(row);
    requireString(row, "accessKind");
    requireString(row, "receiverKind");
    requireString(row, "receiverRaw");
    requireString(row, "propertyKind");
    if (row.propertyKind === "static") requireString(row, "property");
    if (row.propertyKind === "computed") requireString(row, "propertyExpression");
  });

  await auditJsonl(factFiles.assignments, (row) => {
    requireKind(row, "assignment");
    requireSource(row);
    requireString(row, "assignmentKind");
    requireString(row, "leftText");
    requireString(row, "rightText");
  });

  await auditJsonl(factFiles.localBindings, (row) => {
    requireKind(row, "local_binding");
    requireSource(row);
    requireString(row, "variable");
    requireString(row, "bindingKind");
    requireString(row, "rightText");
    requireOptionalString(row, "object");
    requireOptionalString(row, "symbol");
  });

  await auditJsonl(factFiles.destructuringBindings, (row) => {
    requireKind(row, "destructuring_binding");
    requireSource(row);
    requireString(row, "variable");
    requireString(row, "patternText");
    requireString(row, "rightText");
  });

  await auditJsonl(factFiles.loopBindings, (row) => {
    requireKind(row, "loop_binding");
    requireSource(row);
    requireString(row, "variable");
    requireString(row, "collectionText");
    requireString(row, "collectionKind");
  });

  await auditJsonl(factFiles.branchGuards, (row) => {
    requireKind(row, "branch_guard");
    requireSource(row);
    requireString(row, "guardKind");
    requireString(row, "guardPolarity");
    requireString(row, "guardScope");
    requireOptionalString(row, "terminalKind");
    if (row.guardKind === "has_property") {
      requireString(row, "receiverKind");
      requireString(row, "receiverRaw");
      requireString(row, "property");
      requireOptionalNumber(row, "guardedLine");
      requireOptionalNumber(row, "guardedColumn");
    } else if (row.guardKind === "valid") {
      requireString(row, "variable");
      requireOptionalNumber(row, "guardedLine");
      requireOptionalNumber(row, "guardedColumn");
    } else if (row.guardKind === "match_failure") {
      requireString(row, "variable");
    } else if (row.guardKind === "isa") {
      requireOptionalString(row, "variable");
      requireOptionalString(row, "receiverKind");
      requireOptionalString(row, "receiverRaw");
      requireString(row, "targetKind");
      requireString(row, "targetRaw");
    } else if (row.guardKind === "has_callable_verb" || row.guardKind === "has_verb") {
      requireString(row, "receiverKind");
      requireString(row, "receiverRaw");
      requireString(row, "verb");
      requireOptionalNumber(row, "guardedLine");
      requireOptionalNumber(row, "guardedColumn");
    } else {
      issues.push({ file: currentFile, line: currentLine, message: `Unexpected guardKind ${String(row.guardKind)}` });
    }
    requireString(row, "conditionText");
    requireString(row, "guardText");
  });

  await auditJsonl(factFiles.comments, (row) => {
    requireKind(row, "comment");
    requireSource(row);
    requireString(row, "text");
  });

  await auditJsonl(factFiles.parseErrors, (row) => {
    requireKind(row, "parse_error");
    requireSource(row);
    requireString(row, "message");
    requireOptionalString(row, "errorText");
    requireOptionalString(row, "parentType");
    requireOptionalString(row, "sourceLine");
  });

  compareCount(stats, "callsiteCount", factFiles.callsites);
  compareCount(stats, "functionCallCount", factFiles.functionCalls);
  compareCount(stats, "objectRefCount", factFiles.objectRefs);
  compareCount(stats, "systemObjectRefCount", factFiles.systemObjectRefs);
  compareCount(stats, "propertyAccessCount", factFiles.propertyAccesses);
  compareCount(stats, "assignmentCount", factFiles.assignments);
  compareCount(stats, "localBindingCount", factFiles.localBindings);
  compareCount(stats, "destructuringBindingCount", factFiles.destructuringBindings);
  compareCount(stats, "loopBindingCount", factFiles.loopBindings);
  compareCount(stats, "branchGuardCount", factFiles.branchGuards);
  compareCount(stats, "commentCount", factFiles.comments);
  compareCount(stats, "parseErrorCount", factFiles.parseErrors);

  const report = { graphDir, counts, stats, issueCount: issues.length };
  console.log(JSON.stringify(report, null, 2));
  if (issues.length > 0) {
    for (const issue of issues.slice(0, 50)) {
      console.error(`${issue.file}${issue.line !== undefined ? `:${issue.line}` : ""}: ${issue.message}`);
    }
    process.exit(1);
  }
}

let currentFile = "";
let currentLine = 0;

async function auditJsonl(relativePath: string, audit: (row: Record<string, unknown>) => void): Promise<void> {
  currentFile = relativePath;
  const rows = await readJsonl(join(graphDir, relativePath));
  counts[relativePath] = rows.length;
  for (let index = 0; index < rows.length; index += 1) {
    currentLine = index + 1;
    audit(rows[index]!);
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch (cause) {
        issues.push({ file: path, line: index + 1, message: cause instanceof Error ? cause.message : String(cause) });
        return {};
      }
    });
}

function requireFile(relativePath: string): void {
  if (!existsSync(join(graphDir, relativePath))) {
    issues.push({ file: relativePath, message: "Missing required graph output file" });
  }
}

function requireKind(row: Record<string, unknown>, kind: string): void {
  if (row.kind !== kind) {
    issues.push({ file: currentFile, line: currentLine, message: `Expected kind ${kind}, got ${String(row.kind)}` });
  }
}

function requireSource(row: Record<string, unknown>): void {
  requireString(row, "sourceVerbId");
  requireString(row, "sourceObject");
  requireString(row, "sourcePath");
  requireNumber(row, "line");
  requireNumber(row, "column");
  requireOptionalString(row, "controlFlowKind");
  requireOptionalNumber(row, "controlFlowDepth");
  requireOptionalStringArray(row, "controlFlowPath");
}

function requireString(row: Record<string, unknown>, key: string): void {
  if (typeof row[key] !== "string" || row[key] === "") {
    issues.push({ file: currentFile, line: currentLine, message: `Missing nonempty string field ${key}` });
  }
}

function requireOptionalString(row: Record<string, unknown>, key: string): void {
  if (row[key] !== undefined && typeof row[key] !== "string") {
    issues.push({ file: currentFile, line: currentLine, message: `Expected optional string field ${key}` });
  }
}

function requireNumber(row: Record<string, unknown>, key: string): void {
  if (typeof row[key] !== "number" || !Number.isInteger(row[key]) || row[key] < 0) {
    issues.push({ file: currentFile, line: currentLine, message: `Missing nonnegative integer field ${key}` });
  }
}

function requireOptionalNumber(row: Record<string, unknown>, key: string): void {
  if (row[key] !== undefined && (typeof row[key] !== "number" || !Number.isInteger(row[key]) || row[key] < 0)) {
    issues.push({ file: currentFile, line: currentLine, message: `Expected optional nonnegative integer field ${key}` });
  }
}

function requireOptionalStringArray(row: Record<string, unknown>, key: string): void {
  const value = row[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    issues.push({ file: currentFile, line: currentLine, message: `Expected optional string array field ${key}` });
  }
}

function compareCount(stats: Record<string, unknown>, statsKey: string, file: string): void {
  const expected = stats[statsKey];
  const actual = counts[file];
  if (expected !== actual) {
    issues.push({ file: "code_facts/stats.json", message: `${statsKey} is ${String(expected)}, but ${file} has ${String(actual)} rows` });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
