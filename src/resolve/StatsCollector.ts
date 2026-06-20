import type { ResolveStats } from "./types.js";

export function createEmptyResolveStats(): ResolveStats {
  return {
    systemObjectRefCount: 0,
    resolvedSystemObjectRefCount: 0,
    unresolvedSystemObjectRefCount: 0,
    rootPropertyRefCount: 0,
    resolvedRootPropertyRefCount: 0,
    rootVerbFunctionCallCount: 0,
    resolvedRootVerbFunctionCallCount: 0,
    unresolvedRootVerbFunctionCallCount: 0,
    literalObjectRefCount: 0,
    resolvedLiteralObjectRefCount: 0,
    unresolvedLiteralObjectRefCount: 0,
    staticVerbCallsiteCount: 0,
    resolvedVerbCallCandidateCount: 0,
    inheritedVerbCallCandidateCount: 0,
    unresolvedVerbCallCandidateCount: 0,
    staticPropertyAccessCount: 0,
    resolvedPropertyCandidateCount: 0,
    inheritedPropertyCandidateCount: 0,
    builtInPropertyCandidateCount: 0,
    guardedPropertyAccessCount: 0,
    guardedVerbCallCount: 0,
    unresolvedPropertyAccessCount: 0,
    localVariableStateCount: 0,
    inferredReceiverCandidateCount: 0
  };
}
