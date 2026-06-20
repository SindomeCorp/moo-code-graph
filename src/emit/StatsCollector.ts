import type { ExtractedFacts } from "../facts/types.js";
import type { IndexStats } from "../index.js";

export function createEmptyStats(): IndexStats {
  return {
    verbCount: 0,
    verbCodeFileCount: 0,
    parsedFileCount: 0,
    parseErrorCount: 0,
    callsiteCount: 0,
    functionCallCount: 0,
    objectRefCount: 0,
    systemObjectRefCount: 0,
    propertyAccessCount: 0,
    assignmentCount: 0,
    localBindingCount: 0,
    destructuringBindingCount: 0,
    loopBindingCount: 0,
    branchGuardCount: 0,
    verbMetricCount: 0,
    identifierRefCount: 0,
    stringLiteralCount: 0,
    commentCount: 0
  };
}

export function addFactsToStats(stats: IndexStats, facts: ExtractedFacts): void {
  stats.verbMetricCount += facts.verbMetrics.length;
  stats.identifierRefCount += facts.identifierRefs.length;
  stats.stringLiteralCount += facts.stringLiterals.length;
  stats.parseErrorCount += facts.parseErrors.length;
  stats.callsiteCount += facts.callsites.length;
  stats.functionCallCount += facts.functionCalls.length;
  stats.objectRefCount += facts.objectRefs.length;
  stats.systemObjectRefCount += facts.systemObjectRefs.length;
  stats.propertyAccessCount += facts.propertyAccesses.length;
  stats.assignmentCount += facts.assignments.length;
  stats.localBindingCount += facts.localBindings.length;
  stats.destructuringBindingCount += facts.destructuringBindings.length;
  stats.loopBindingCount += facts.loopBindings.length;
  stats.branchGuardCount += facts.branchGuards.length;
  stats.commentCount += facts.comments.length;
}
