import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { UnresolvedPropertyAccessFinding, UnresolvedVerbCallFinding } from "../resolve/types.js";

export interface ReportUnresolvedOptions {
  resolvedDir: string;
  top?: number;
  examplesPerGroup?: number;
}

export interface UnresolvedVerbCallGroup {
  sourceVerbId: string;
  sourceVerbName: string;
  sourceObject: string;
  sourcePath: string;
  count: number;
  findings: UnresolvedVerbCallFinding[];
}

export interface UnresolvedReasonGroup {
  reason: string;
  count: number;
}

export interface UnresolvedPropertyAccessGroup {
  sourceVerbId: string;
  sourceVerbName: string;
  sourceObject: string;
  sourcePath: string;
  count: number;
  findings: UnresolvedPropertyAccessFinding[];
}

export interface UnresolvedReport {
  resolvedDir: string;
  examplesPerGroup: number;
  unresolvedVerbCallCount: number;
  unresolvedPropertyAccessCount: number;
  byReason: UnresolvedReasonGroup[];
  propertyByReason: UnresolvedReasonGroup[];
  bySourceVerb: UnresolvedVerbCallGroup[];
  propertyBySourceVerb: UnresolvedPropertyAccessGroup[];
}

export async function reportUnresolved(options: ReportUnresolvedOptions): Promise<UnresolvedReport> {
  const findingsPath = join(options.resolvedDir, "findings", "unresolved_verb_calls.jsonl");
  const propertyFindingsPath = join(options.resolvedDir, "findings", "unresolved_property_accesses.jsonl");
  const findings = sortFindings(await readJsonl<UnresolvedVerbCallFinding>(findingsPath));
  const propertyFindings = sortPropertyFindings(await readJsonlIfExists<UnresolvedPropertyAccessFinding>(propertyFindingsPath));
  const top = options.top ?? findings.length;
  const examplesPerGroup = options.examplesPerGroup ?? 10;

  return {
    resolvedDir: options.resolvedDir,
    examplesPerGroup,
    unresolvedVerbCallCount: findings.length,
    unresolvedPropertyAccessCount: propertyFindings.length,
    byReason: groupReasons(findings),
    propertyByReason: groupPropertyReasons(propertyFindings),
    bySourceVerb: groupSourceVerbs(findings, examplesPerGroup).slice(0, top),
    propertyBySourceVerb: groupPropertySourceVerbs(propertyFindings, examplesPerGroup).slice(0, top)
  };
}

export function formatUnresolvedReport(report: UnresolvedReport): string {
  const lines: string[] = [];
  lines.push(`Unresolved verb calls: ${report.unresolvedVerbCallCount}`);
  lines.push(`Unresolved property accesses: ${report.unresolvedPropertyAccessCount}`);

  if (report.byReason.length > 0) {
    lines.push("");
    lines.push("By reason:");
    for (const reason of report.byReason) {
      lines.push(`  ${reason.reason}: ${reason.count}`);
    }
  }

  if (report.propertyByReason.length > 0) {
    lines.push("");
    lines.push("Property accesses by reason:");
    for (const reason of report.propertyByReason) {
      lines.push(`  ${reason.reason}: ${reason.count}`);
    }
  }

  if (report.bySourceVerb.length > 0) {
    lines.push("");
    lines.push("By source verb:");
    for (const group of report.bySourceVerb) {
      lines.push(`  ${group.sourceObject}:${group.sourceVerbName} (${group.sourceVerbId}) - ${group.count}`);
      lines.push(`    ${group.sourcePath}`);
      for (const finding of group.findings) {
        const location = `${finding.line}:${finding.column}`;
        const target = finding.receiverObject ? ` -> ${finding.receiverObject}` : "";
        lines.push(`    ${location} ${finding.ref}${target} [${finding.reason}]`);
        if (finding.inlineErrorHandled) lines.push(`      handled inline errors: ${(finding.inlineErrorCodes ?? []).join(", ") || "unknown"}`);
        if (finding.sourceLine) lines.push(`      ${finding.sourceLine.trim()}`);
      }
    }
  }

  if (report.propertyBySourceVerb.length > 0) {
    lines.push("");
    lines.push("Property accesses by source verb:");
    for (const group of report.propertyBySourceVerb) {
      lines.push(`  ${group.sourceObject}:${group.sourceVerbName} (${group.sourceVerbId}) - ${group.count}`);
      lines.push(`    ${group.sourcePath}`);
      for (const finding of group.findings) {
        const location = `${finding.line}:${finding.column}`;
        const target = finding.receiverObject ? ` -> ${finding.receiverObject}` : "";
        lines.push(`    ${location} ${finding.ref}${target} [${finding.reason}]`);
        if (finding.sourceLine) lines.push(`      ${finding.sourceLine.trim()}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function readJsonlIfExists<T>(path: string): Promise<T[]> {
  try {
    return await readJsonl<T>(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
}

function groupReasons(findings: UnresolvedVerbCallFinding[]): UnresolvedReasonGroup[] {
  const groups = new Map<string, number>();
  for (const finding of findings) {
    groups.set(finding.reason, (groups.get(finding.reason) ?? 0) + 1);
  }
  return [...groups.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function groupPropertyReasons(findings: UnresolvedPropertyAccessFinding[]): UnresolvedReasonGroup[] {
  const groups = new Map<string, number>();
  for (const finding of findings) {
    groups.set(finding.reason, (groups.get(finding.reason) ?? 0) + 1);
  }
  return [...groups.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function groupSourceVerbs(findings: UnresolvedVerbCallFinding[], examplesPerGroup: number): UnresolvedVerbCallGroup[] {
  const groups = new Map<string, UnresolvedVerbCallFinding[]>();
  for (const finding of findings) {
    const key = [finding.sourceVerbId, finding.sourceVerbName, finding.sourceObject, finding.sourcePath].join("\t");
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((groupFindings) => {
      const first = groupFindings[0]!;
      return {
        sourceVerbId: first.sourceVerbId,
        sourceVerbName: first.sourceVerbName,
        sourceObject: first.sourceObject,
        sourcePath: first.sourcePath,
        count: groupFindings.length,
        findings: sortFindings(groupFindings).slice(0, examplesPerGroup)
      };
    })
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.sourceObject.localeCompare(right.sourceObject) ||
        left.sourceVerbName.localeCompare(right.sourceVerbName) ||
        left.sourceVerbId.localeCompare(right.sourceVerbId)
    );
}

function groupPropertySourceVerbs(
  findings: UnresolvedPropertyAccessFinding[],
  examplesPerGroup: number
): UnresolvedPropertyAccessGroup[] {
  const groups = new Map<string, UnresolvedPropertyAccessFinding[]>();
  for (const finding of findings) {
    const key = [finding.sourceVerbId, finding.sourceVerbName, finding.sourceObject, finding.sourcePath].join("\t");
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((groupFindings) => {
      const first = groupFindings[0]!;
      return {
        sourceVerbId: first.sourceVerbId,
        sourceVerbName: first.sourceVerbName,
        sourceObject: first.sourceObject,
        sourcePath: first.sourcePath,
        count: groupFindings.length,
        findings: sortPropertyFindings(groupFindings).slice(0, examplesPerGroup)
      };
    })
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.sourceObject.localeCompare(right.sourceObject) ||
        left.sourceVerbName.localeCompare(right.sourceVerbName) ||
        left.sourceVerbId.localeCompare(right.sourceVerbId)
    );
}

function sortFindings(findings: UnresolvedVerbCallFinding[]): UnresolvedVerbCallFinding[] {
  return [...findings].sort(
    (left, right) =>
      left.sourceObject.localeCompare(right.sourceObject) ||
      left.sourceVerbName.localeCompare(right.sourceVerbName) ||
      left.sourceVerbId.localeCompare(right.sourceVerbId) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ref.localeCompare(right.ref)
  );
}

function sortPropertyFindings(findings: UnresolvedPropertyAccessFinding[]): UnresolvedPropertyAccessFinding[] {
  return [...findings].sort(
    (left, right) =>
      left.sourceObject.localeCompare(right.sourceObject) ||
      left.sourceVerbName.localeCompare(right.sourceVerbName) ||
      left.sourceVerbId.localeCompare(right.sourceVerbId) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ref.localeCompare(right.ref)
  );
}
