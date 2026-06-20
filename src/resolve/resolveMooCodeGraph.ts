import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import type {
  CoreCandidateRecord,
  ExtractedObjectRecord,
  ExtractedPropertyDefinitionRecord,
  ExtractedPropertyValueRecord,
  ExtractedVerbRecord,
  ObjectRef
} from "@sindomecorp/toaststunt-db-extractor";
import { JsonlWriter } from "../emit/JsonlWriter.js";
import { CodeGraphError } from "../errors/CodeGraphError.js";
import { analyzeLocalFlow, type LocalFlowAnalysis } from "../flow/analyzeLocalFlow.js";
import type { InferredReceiverCandidateFact, KnownObjectBindingInput, LocalVariableStateFact, VariableUseInput } from "../flow/types.js";
import { readJsonl } from "../load/JsonlReader.js";
import { loadCoreCandidates } from "../load/loadCoreCandidates.js";
import { loadExtractManifest } from "../load/loadExtractManifest.js";
import { loadObjects } from "../load/loadObjects.js";
import { loadProperties } from "../load/loadProperties.js";
import { loadVerbs } from "../load/loadVerbs.js";
import { createEmptyResolveStats } from "./StatsCollector.js";
import { writeResolveManifest } from "./ManifestWriter.js";
import { matchesVerbName } from "./matchVerbName.js";
import type {
  AssignmentInput,
  BranchGuardInput,
  CallsiteInput,
  DestructuringBindingInput,
  FunctionCallInput,
  LiteralObjectEdge,
  LocalBindingInput,
  LoopBindingInput,
  ObjectRefInput,
  PropertyAccessInput,
  PropertyCandidateEdge,
  GuardedPropertyAccessEdge,
  GuardedVerbCallEdge,
  ResolvedEdges,
  ResolveMooCodeGraphOptions,
  ResolveResult,
  RootPropertyEdge,
  RootVerbCallEdge,
  SystemObjectEdge,
  SystemObjectRefInput,
  UnresolvedRef,
  UnresolvedPropertyAccessFinding,
  UnresolvedVerbCallFinding,
  VerbCallCandidateEdge
} from "./types.js";

interface GraphManifest {
  factSchemaVersion?: string;
}

export async function resolveMooCodeGraph(options: ResolveMooCodeGraphOptions): Promise<ResolveResult> {
  const startedAt = new Date().toISOString();

  options.onProgress?.({ phase: "load_graph", message: "Loading raw graph facts" });
  const graphManifest = await loadGraphManifest(options.graphDir);
  const callsites = await readJsonl<CallsiteInput>(join(options.graphDir, "code_facts", "callsites.jsonl"));
  const functionCalls = await readJsonl<FunctionCallInput>(join(options.graphDir, "code_facts", "function_calls.jsonl"));
  const propertyAccesses = await readJsonl<PropertyAccessInput>(join(options.graphDir, "code_facts", "property_accesses.jsonl"));
  const assignments = await readJsonl<AssignmentInput>(join(options.graphDir, "code_facts", "assignments.jsonl"));
  const localBindings = await readJsonl<LocalBindingInput>(join(options.graphDir, "code_facts", "local_bindings.jsonl"));
  const destructuringBindings = await readJsonl<DestructuringBindingInput>(join(options.graphDir, "code_facts", "destructuring_bindings.jsonl"));
  const loopBindings = await readJsonl<LoopBindingInput>(join(options.graphDir, "code_facts", "loop_bindings.jsonl"));
  const branchGuards = await readJsonl<BranchGuardInput>(join(options.graphDir, "code_facts", "branch_guards.jsonl"));
  const systemObjectRefs = await readJsonl<SystemObjectRefInput>(join(options.graphDir, "code_facts", "system_object_refs.jsonl"));
  const objectRefs = await readJsonl<ObjectRefInput>(join(options.graphDir, "code_facts", "object_refs.jsonl"));

  options.onProgress?.({ phase: "load_extract", message: "Loading extractor metadata" });
  const extractManifest = await loadExtractManifest(options.extractDir);
  const coreCandidates = await loadCoreCandidates(options.extractDir);
  const objects = await loadObjects(options.extractDir);
  const properties = await loadProperties(options.extractDir);
  const propertyValues = await loadRelevantPropertyValues(options.extractDir, propertyAccesses);
  const verbs = await loadVerbs(options.extractDir);
  const coreBySymbol = buildCoreCandidateMap(coreCandidates);
  const objectMap = buildObjectMap(objects);
  const objectIds = new Set(objectMap.keys());
  const verbIndex = buildVerbIndex(verbs);
  const verbById = buildVerbIdMap(verbs);
  const propertyIndex = buildPropertyIndex(properties);
  const propertyValueIndex = buildPropertyValueIndex(propertyValues);
  const propertyAccessTextIndex = buildPropertyAccessTextIndex(propertyAccesses);
  const sourceVerbNames = buildSourceVerbNameMap(verbs);
  const localBindingIndex = buildLocalBindingIndex(localBindings);
  const destructuringBindingIndex = buildVariableBindingIndex(destructuringBindings);
  const loopBindingIndex = buildVariableBindingIndex(loopBindings);
  const objectFlowBindingIndex = buildObjectFlowBindingIndex(
    assignments,
    propertyAccessTextIndex,
    coreBySymbol,
    objectMap,
    propertyValueIndex,
    localBindingIndex,
    destructuringBindingIndex,
    loopBindingIndex
  );
  const loopObjectBindingIndex = buildLoopObjectBindingIndex(
    loopBindings,
    propertyAccessTextIndex,
    coreBySymbol,
    objectMap,
    propertyValueIndex,
    localBindingIndex,
    destructuringBindingIndex,
    loopBindingIndex,
    objectFlowBindingIndex
  );
  const flowAnalysis = analyzeLocalFlow({
    assignments,
    destructuringBindings,
    loopBindings,
    knownObjectBindings: [
      ...buildKnownLocalObjectBindings(localBindings, coreBySymbol, objectMap),
      ...buildKnownIsaGuardBindings(branchGuards, coreBySymbol, objectMap, localBindingIndex, objectFlowBindingIndex, loopObjectBindingIndex),
      ...buildKnownValidGuardBindings(branchGuards),
      ...buildKnownMatchFailureGuardBindings(branchGuards),
      ...flattenObjectFlowBindings(objectFlowBindingIndex, sourceByVerbId(localBindings, assignments, loopBindings), "object_property_assignment"),
      ...flattenObjectFlowBindings(loopObjectBindingIndex, sourceByVerbId(localBindings, assignments, loopBindings), "contents_loop")
    ]
  });
  const inferredReceiverCandidates = flowAnalysis.buildInferredReceiverCandidates(variableReceiverUses(callsites, propertyAccesses));
  const sourceLines = new SourceLineCache(options.extractDir);

  const stats = createEmptyResolveStats();
  stats.systemObjectRefCount = systemObjectRefs.length;
  stats.literalObjectRefCount = objectRefs.length;

  options.onProgress?.({ phase: "resolve_system_objects", total: systemObjectRefs.length });
  const rootFunctionCallKeys = buildRootFunctionCallKeySet(functionCalls);
  const systemObjectResult = resolveSystemObjectRefs(
    systemObjectRefs,
    coreBySymbol,
    objectIds,
    propertyIndex,
    rootFunctionCallKeys,
    sourceVerbNames
  );
  stats.resolvedSystemObjectRefCount = systemObjectResult.systemObjectEdges.length;
  stats.unresolvedSystemObjectRefCount = systemObjectResult.unresolvedRefs.length;
  stats.rootPropertyRefCount = systemObjectResult.rootPropertyEdges.length;
  stats.resolvedRootPropertyRefCount = systemObjectResult.rootPropertyEdges.length;

  options.onProgress?.({ phase: "resolve_literal_objects", total: objectRefs.length });
  const literalObjectResult = resolveLiteralObjectRefs(objectRefs, objectIds, sourceVerbNames);
  stats.resolvedLiteralObjectRefCount = literalObjectResult.literalObjectEdges.length;
  stats.unresolvedLiteralObjectRefCount = literalObjectResult.unresolvedRefs.length;

  options.onProgress?.({ phase: "resolve_verb_calls", total: callsites.length });
  const verbCallResult = await resolveVerbCallCandidates(
    callsites,
    coreBySymbol,
    objectMap,
    verbIndex,
    sourceVerbNames,
    localBindingIndex,
    destructuringBindingIndex,
    loopBindingIndex,
    objectFlowBindingIndex,
    loopObjectBindingIndex,
    flowAnalysis,
    branchGuards,
    sourceLines
  );
  stats.staticVerbCallsiteCount = verbCallResult.staticVerbCallsiteCount;
  stats.resolvedVerbCallCandidateCount = verbCallResult.verbCallCandidateEdges.length;
  stats.inheritedVerbCallCandidateCount = verbCallResult.verbCallCandidateEdges.filter((edge) => edge.inheritanceDepth > 0).length;
  stats.guardedVerbCallCount = verbCallResult.guardedVerbCallEdges.length;
  stats.unresolvedVerbCallCandidateCount = verbCallResult.unresolvedRefs.length;
  const rootVerbCallResult = resolveRootVerbFunctionCalls(functionCalls, objectMap, verbIndex, sourceVerbNames);
  stats.rootVerbFunctionCallCount = rootVerbCallResult.rootVerbFunctionCallCount;
  stats.resolvedRootVerbFunctionCallCount = rootVerbCallResult.rootVerbCallEdges.length;
  stats.unresolvedRootVerbFunctionCallCount = rootVerbCallResult.unresolvedRefs.length;

  options.onProgress?.({ phase: "resolve_property_accesses", total: propertyAccesses.length });
  const propertyResult = await resolvePropertyAccesses(
    propertyAccesses,
    coreBySymbol,
    objectMap,
    propertyIndex,
    verbById,
    propertyValueIndex,
    propertyAccessTextIndex,
    sourceVerbNames,
    localBindingIndex,
    destructuringBindingIndex,
    loopBindingIndex,
    objectFlowBindingIndex,
    loopObjectBindingIndex,
    flowAnalysis,
    branchGuards,
    sourceLines
  );
  stats.staticPropertyAccessCount = propertyResult.staticPropertyAccessCount;
  stats.resolvedPropertyCandidateCount = propertyResult.propertyCandidateEdges.length;
  stats.inheritedPropertyCandidateCount = propertyResult.propertyCandidateEdges.filter((edge) => edge.inheritanceDepth > 0).length;
  stats.builtInPropertyCandidateCount = propertyResult.propertyCandidateEdges.filter((edge) => edge.resolutionKind === "built_in_property").length;
  stats.guardedPropertyAccessCount = propertyResult.guardedPropertyAccessEdges.length;
  stats.unresolvedPropertyAccessCount = propertyResult.unresolvedPropertyAccessFindings.length;
  stats.localVariableStateCount = flowAnalysis.states.length;
  stats.inferredReceiverCandidateCount = inferredReceiverCandidates.length;

  if (options.overwrite) await rm(options.outputDir, { recursive: true, force: true });
  await mkdir(join(options.outputDir, "edges"), { recursive: true });
  await mkdir(join(options.outputDir, "findings"), { recursive: true });
  await mkdir(join(options.outputDir, "flow"), { recursive: true });

  options.onProgress?.({ phase: "emit_edges", message: "Writing resolved edges" });
  await writeEdges(options.outputDir, options.pretty ?? false, {
    systemObjectEdges: systemObjectResult.systemObjectEdges,
    rootPropertyEdges: systemObjectResult.rootPropertyEdges,
    rootVerbCallEdges: rootVerbCallResult.rootVerbCallEdges,
    literalObjectEdges: literalObjectResult.literalObjectEdges,
    verbCallCandidateEdges: verbCallResult.verbCallCandidateEdges,
    propertyCandidateEdges: propertyResult.propertyCandidateEdges,
    guardedPropertyAccessEdges: propertyResult.guardedPropertyAccessEdges,
    guardedVerbCallEdges: verbCallResult.guardedVerbCallEdges,
    unresolvedRefs: [
      ...systemObjectResult.unresolvedRefs,
      ...literalObjectResult.unresolvedRefs,
      ...verbCallResult.unresolvedRefs,
      ...rootVerbCallResult.unresolvedRefs
    ],
    unresolvedVerbCallFindings: await buildUnresolvedVerbCallFindings([...verbCallResult.unresolvedRefs, ...rootVerbCallResult.unresolvedRefs], sourceLines),
    unresolvedPropertyAccessFindings: propertyResult.unresolvedPropertyAccessFindings,
    localVariableStates: flowAnalysis.states,
    inferredReceiverCandidates
  });
  await writeFile(join(options.outputDir, "edges", "stats.json"), `${JSON.stringify(stats, null, 2)}\n`, "utf8");

  options.onProgress?.({ phase: "write_manifest", message: "Writing resolver manifest" });
  await writeResolveManifest({
    outputDir: options.outputDir,
    sourceGraphDir: options.graphDir,
    sourceExtractDir: options.extractDir,
    sourceExtractManifest: extractManifest,
    sourceFactSchemaVersion: graphManifest.factSchemaVersion,
    startedAt,
    completedAt: new Date().toISOString(),
    pretty: options.pretty
  });

  options.onProgress?.({ phase: "done", message: "Resolve complete" });
  return { graphDir: options.graphDir, extractDir: options.extractDir, outputDir: options.outputDir, stats };
}

async function loadGraphManifest(graphDir: string): Promise<GraphManifest> {
  try {
    return JSON.parse(await readFile(join(graphDir, "manifest.json"), "utf8")) as GraphManifest;
  } catch (cause) {
    throw new CodeGraphError("Unable to load graph manifest", { graphDir, cause: cause instanceof Error ? cause.message : String(cause) });
  }
}

function buildCoreCandidateMap(coreCandidates: CoreCandidateRecord[]): Map<string, CoreCandidateRecord> {
  const map = new Map<string, CoreCandidateRecord>();
  for (const candidate of coreCandidates) {
    const key = coreSymbolKey(candidate.symbol);
    if (!map.has(key)) map.set(key, candidate);
  }
  return map;
}

function coreSymbolKey(symbol: string): string {
  return symbol.toLowerCase();
}

function variableKey(sourceVerbId: string, variable: string): string {
  return `${sourceVerbId}\t${variable.toLowerCase()}`;
}

function buildObjectMap(objects: ExtractedObjectRecord[]): Map<ObjectRef, ExtractedObjectRecord> {
  const map = new Map<ObjectRef, ExtractedObjectRecord>();
  for (const object of objects) {
    map.set(object.id, object);
  }
  return map;
}

function buildVerbIndex(verbs: ExtractedVerbRecord[]): Map<string, ExtractedVerbRecord[]> {
  const index = new Map<string, ExtractedVerbRecord[]>();
  for (const verb of verbs) {
    const existing = index.get(verb.object) ?? [];
    existing.push(verb);
    index.set(verb.object, existing);
  }
  return index;
}

function buildVerbIdMap(verbs: ExtractedVerbRecord[]): Map<string, ExtractedVerbRecord> {
  return new Map(verbs.map((verb) => [verb.id, verb]));
}

function buildPropertyIndex(properties: ExtractedPropertyDefinitionRecord[]): Map<string, ExtractedPropertyDefinitionRecord[]> {
  const index = new Map<string, ExtractedPropertyDefinitionRecord[]>();
  for (const property of properties) {
    const existing = index.get(property.object) ?? [];
    existing.push(property);
    index.set(property.object, existing);
  }
  return index;
}

function buildPropertyValueIndex(values: ExtractedPropertyValueRecord[]): Map<string, ExtractedPropertyValueRecord> {
  const index = new Map<string, ExtractedPropertyValueRecord>();
  for (const value of values) {
    if (!value.name) continue;
    index.set(propertyValueKey(value.object, value.name), value);
  }
  return index;
}

async function loadRelevantPropertyValues(
  extractDir: string,
  propertyAccesses: PropertyAccessInput[]
): Promise<ExtractedPropertyValueRecord[]> {
  const relevantNames = new Set(
    propertyAccesses
      .filter((access) => access.propertyKind === "static" && access.property && !BUILT_IN_PROPERTIES.has(access.property.toLowerCase()))
      .map((access) => access.property!.toLowerCase())
  );
  if (relevantNames.size === 0) return [];

  const rows: ExtractedPropertyValueRecord[] = [];
  const path = join(extractDir, "property_values.jsonl");
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let row: ExtractedPropertyValueRecord;
      try {
        row = JSON.parse(line) as ExtractedPropertyValueRecord;
      } catch (cause) {
        throw new Error(`Invalid JSONL in ${path} at line ${lineNumber}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (!row.name || !relevantNames.has(row.name.toLowerCase())) continue;
      if (row.value.type === "object" || row.value.type === "list") rows.push(row);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return rows;
}

function propertyValueKey(object: string, property: string): string {
  return `${object}\t${property.toLowerCase()}`;
}

function buildPropertyAccessTextIndex(accesses: PropertyAccessInput[]): Map<string, PropertyAccessInput[]> {
  const index = new Map<string, PropertyAccessInput[]>();
  for (const access of accesses) {
    const key = `${access.sourceVerbId}\t${propertyAccessText(access)}`;
    const existing = index.get(key) ?? [];
    existing.push(access);
    index.set(key, existing);
  }
  for (const existing of index.values()) {
    existing.sort((left, right) => left.line - right.line || left.column - right.column);
  }
  return index;
}

function propertyAccessText(access: PropertyAccessInput): string {
  return access.propertyKind === "static"
    ? `${access.receiverRaw}.${access.property ?? ""}`
    : `${access.receiverRaw}.(${access.propertyExpression ?? ""})`;
}

function buildObjectFlowBindingIndex(
  assignments: AssignmentInput[],
  propertyAccessTextIndex: Map<string, PropertyAccessInput[]>,
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  propertyValueIndex: Map<string, ExtractedPropertyValueRecord>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>
): Map<string, ObjectFlowBinding[]> {
  const bindings: ObjectFlowBinding[] = [];
  for (const assignment of assignments) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(assignment.leftText)) continue;
    const access = findPropertyAccessAtOrAfter(propertyAccessTextIndex, assignment.sourceVerbId, assignment.rightText, assignment);
    if (!access || access.propertyKind !== "static" || !access.property) continue;
    const receiverObject = resolvePropertyReceiverObject(
      access,
      coreBySymbol,
      objectMap,
      propertyValueIndex,
      propertyAccessTextIndex,
      localBindingIndex,
      destructuringBindingIndex,
      loopBindingIndex,
      new Map(),
      new Map()
    );
    if (!receiverObject.object) continue;
    const objects = resolveObjectValuedProperty(receiverObject.object, access.property, objectMap, propertyValueIndex).filter((object) =>
      objectMap.has(object)
    );
    if (objects.length === 0) continue;
    bindings.push({
      sourceVerbId: assignment.sourceVerbId,
      variable: assignment.leftText,
      line: assignment.line,
      column: assignment.column,
      objects,
      bindingKind: "object_property_assignment",
      provenance: "object_property_assignment",
      ...controlFlowFields(assignment)
    });
  }
  return buildObjectFlowIndex(bindings);
}

function buildLoopObjectBindingIndex(
  loopBindings: LoopBindingInput[],
  propertyAccessTextIndex: Map<string, PropertyAccessInput[]>,
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  propertyValueIndex: Map<string, ExtractedPropertyValueRecord>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>
): Map<string, ObjectFlowBinding[]> {
  const bindings: ObjectFlowBinding[] = [];
  for (const loop of loopBindings) {
    const collectionText = stripBalancedParens(loop.collectionText);
    const access = findPropertyAccessAtOrAfter(propertyAccessTextIndex, loop.sourceVerbId, collectionText, loop);
    if (access?.propertyKind === "static" && access.property) {
      const receiverObject = resolvePropertyReceiverObject(
        access,
        coreBySymbol,
        objectMap,
        propertyValueIndex,
        propertyAccessTextIndex,
        localBindingIndex,
        destructuringBindingIndex,
        loopBindingIndex,
        objectFlowBindingIndex,
        new Map()
      );
      if (receiverObject.object) {
        const objects = resolveObjectListValuedProperty(receiverObject.object, access.property, objectMap, propertyValueIndex).filter((object) =>
          objectMap.has(object)
        );
        if (objects.length > 0) {
          bindings.push({
            sourceVerbId: loop.sourceVerbId,
            variable: loop.variable,
            line: loop.line,
            column: loop.column,
            objects,
            bindingKind: "contents_loop",
            provenance: access.property.toLowerCase() === "contents" ? "contents_builtin_loop" : "object_list_property_loop",
            ...controlFlowFields(loop)
          });
          continue;
        }
      }
    }

    const functionObjects = resolveObjectListValuedFunction(
      collectionText,
      loop,
      coreBySymbol,
      objectMap,
      localBindingIndex,
      destructuringBindingIndex,
      loopBindingIndex,
      objectFlowBindingIndex,
      new Map()
    );
    if (functionObjects.length === 0) continue;
    bindings.push({
      sourceVerbId: loop.sourceVerbId,
      variable: loop.variable,
      line: loop.line,
      column: loop.column,
      objects: functionObjects,
      bindingKind: "contents_loop",
      provenance: detectObjectListFunctionProvenance(collectionText) ?? "object_list_property_loop",
      ...controlFlowFields(loop)
    });
  }
  return buildObjectFlowIndex(bindings);
}

function detectObjectListFunctionProvenance(collectionText: string): KnownObjectBindingInput["provenance"] | undefined {
  const match = /^(children|parents)\(/i.exec(collectionText);
  if (!match) return undefined;
  return match[1]!.toLowerCase() === "children" ? "children_builtin_loop" : "parents_builtin_loop";
}

function buildObjectFlowIndex(bindings: ObjectFlowBinding[]): Map<string, ObjectFlowBinding[]> {
  const index = new Map<string, ObjectFlowBinding[]>();
  for (const binding of bindings) {
    const key = variableKey(binding.sourceVerbId, binding.variable);
    const existing = index.get(key) ?? [];
    existing.push(binding);
    index.set(key, existing);
  }
  for (const existing of index.values()) {
    existing.sort((left, right) => left.line - right.line || left.column - right.column);
  }
  return index;
}

function stripBalancedParens(text: string): string {
  let current = text.trim();
  while (current.startsWith("(") && current.endsWith(")") && hasBalancedOuterParens(current)) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

function hasBalancedOuterParens(text: string): boolean {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && index < text.length - 1) return false;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function findPropertyAccessAtOrAfter(
  propertyAccessTextIndex: Map<string, PropertyAccessInput[]>,
  sourceVerbId: string,
  text: string,
  atOrAfter: Pick<PropertyAccessInput, "line" | "column">
): PropertyAccessInput | undefined {
  const candidates = propertyAccessTextIndex.get(`${sourceVerbId}\t${text}`) ?? [];
  return candidates.find(
    (candidate) => candidate.line > atOrAfter.line || (candidate.line === atOrAfter.line && candidate.column >= atOrAfter.column)
  );
}

function resolveObjectListValuedFunction(
  collectionText: string,
  loop: LoopBindingInput,
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>,
  loopObjectBindingIndex: Map<string, ObjectFlowBinding[]>
): ObjectRef[] {
  const match = /^(children|parents)\((.*)\)$/i.exec(collectionText);
  if (!match) return [];
  const functionName = match[1]!.toLowerCase();
  const argumentText = stripBalancedParens(match[2] ?? "");
  const argument = receiverInputFromText(argumentText, loop);
  if (!argument) return [];
  const receiverObjects = resolveReceiverObjects(
    argument,
    coreBySymbol,
    objectMap,
    localBindingIndex,
    destructuringBindingIndex,
    loopBindingIndex,
    objectFlowBindingIndex,
    loopObjectBindingIndex
  );
  if (!receiverObjects.objects || receiverObjects.objects.length !== 1) return [];
  const object = objectMap.get(receiverObjects.objects[0]!);
  if (!object) return [];
  if (functionName === "children") return (object.children ?? []).filter((child): child is ObjectRef => typeof child === "string");
  return (object.parents ?? []).filter((parent): parent is ObjectRef => typeof parent === "string" && parent !== "#-1");
}

function receiverInputFromText(
  text: string,
  loop: LoopBindingInput
): Pick<
  CallsiteInput | PropertyAccessInput,
  "receiverKind" | "receiverRaw" | "sourceObject" | "sourcePath" | "sourceVerbId" | "line" | "column" | "controlFlowPath"
> | undefined {
  const base = {
    sourceObject: loop.sourceObject,
    sourcePath: loop.sourcePath,
    sourceVerbId: loop.sourceVerbId,
    line: loop.line,
    column: loop.column,
    ...(loop.controlFlowPath ? { controlFlowPath: loop.controlFlowPath } : {})
  };
  if (text.toLowerCase() === "this") {
    return { ...base, receiverKind: "this", receiverRaw: text };
  }
  if (/^#-?\d+$/.test(text)) {
    return { ...base, receiverKind: "literal_object", receiverRaw: text };
  }
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    return { ...base, receiverKind: "system_object", receiverRaw: text };
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    return { ...base, receiverKind: "variable", receiverRaw: text };
  }
  return undefined;
}

function buildLocalBindingIndex(bindings: LocalBindingInput[]): Map<string, LocalBindingInput[]> {
  const index = new Map<string, LocalBindingInput[]>();
  for (const binding of bindings) {
    const key = variableKey(binding.sourceVerbId, binding.variable);
    const existing = index.get(key) ?? [];
    existing.push(binding);
    index.set(key, existing);
  }
  for (const existing of index.values()) {
    existing.sort((left, right) => left.line - right.line || left.column - right.column);
  }
  return index;
}

function buildVariableBindingIndex<T extends { sourceVerbId: string; variable: string; line: number; column: number }>(bindings: T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const binding of bindings) {
    const key = variableKey(binding.sourceVerbId, binding.variable);
    const existing = index.get(key) ?? [];
    existing.push(binding);
    index.set(key, existing);
  }
  for (const existing of index.values()) {
    existing.sort((left, right) => left.line - right.line || left.column - right.column);
  }
  return index;
}

function buildSourceVerbNameMap(verbs: ExtractedVerbRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const verb of verbs) {
    map.set(verb.id, verb.primaryName ?? verb.names[0] ?? verb.id);
  }
  return map;
}

function sourceVerbNameFor(sourceVerbNames: Map<string, string>, sourceVerbId: string): string {
  return sourceVerbNames.get(sourceVerbId) ?? sourceVerbId;
}

function sourceByVerbId(...groups: Array<Array<Pick<AssignmentInput, "sourceVerbId" | "sourceObject" | "sourcePath">>>): Map<string, Pick<AssignmentInput, "sourceObject" | "sourcePath">> {
  const map = new Map<string, Pick<AssignmentInput, "sourceObject" | "sourcePath">>();
  for (const group of groups) {
    for (const row of group) {
      if (!map.has(row.sourceVerbId)) map.set(row.sourceVerbId, { sourceObject: row.sourceObject, sourcePath: row.sourcePath });
    }
  }
  return map;
}

function buildKnownLocalObjectBindings(
  localBindings: LocalBindingInput[],
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>
): KnownObjectBindingInput[] {
  const known: KnownObjectBindingInput[] = [];
  for (const binding of localBindings) {
    const object = resolveLocalBindingObject(binding, coreBySymbol, objectMap);
    if (!object) continue;
    known.push({
      sourceVerbId: binding.sourceVerbId,
      sourceObject: binding.sourceObject,
      sourcePath: binding.sourcePath,
      variable: binding.variable,
      objects: [object],
      valueKind: "object",
      provenance: localBindingProvenance(binding),
      confidence: "exact",
      sourceText: binding.rightText,
      line: binding.line,
      column: binding.column,
      ...controlFlowFields(binding)
    });
  }
  return known;
}

function buildKnownIsaGuardBindings(
  branchGuards: BranchGuardInput[],
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>,
  loopObjectBindingIndex: Map<string, ObjectFlowBinding[]>
): KnownObjectBindingInput[] {
  const known: KnownObjectBindingInput[] = [];
  for (const guard of branchGuards) {
    if (guard.guardKind !== "isa" || !guard.targetKind || !guard.targetRaw) continue;
    const bindingName = isaGuardBindingName(guard);
    if (!bindingName) continue;
    const isaGuard = guard as BranchGuardInput & { targetKind: "system_object" | "literal_object"; targetRaw: string };
    const object = resolveGuardTargetObject(isaGuard, coreBySymbol, objectMap);
    if (!object) continue;
    const intersected = guard.variable
      ? intersectPriorCandidatesWithIsaTarget(
          guard as BranchGuardInput & { variable: string },
          object,
          coreBySymbol,
          objectMap,
          localBindingIndex,
          objectFlowBindingIndex,
          loopObjectBindingIndex
        )
      : [];
    const objects = intersected.length > 0 ? intersected : [object];
    known.push({
      sourceVerbId: guard.sourceVerbId,
      sourceObject: guard.sourceObject,
      sourcePath: guard.sourcePath,
      variable: bindingName,
      objects,
      valueKind: "object_candidate_set",
      provenance: guard.guardScope === "branch" ? "isa_guard" : "isa_exit_guard",
      confidence: "candidate",
      sourceText: guard.guardText,
      line: guard.line,
      column: guard.column,
      ...controlFlowFields(guard)
    });
  }
  return known;
}

function isaGuardBindingName(guard: BranchGuardInput): string | undefined {
  if (guard.variable) return guard.variable;
  if (guard.receiverKind === "property_access" && guard.receiverRaw) return guard.receiverRaw;
  return undefined;
}

function intersectPriorCandidatesWithIsaTarget(
  guard: BranchGuardInput & { variable: string },
  targetObject: ObjectRef,
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>,
  loopObjectBindingIndex: Map<string, ObjectFlowBinding[]>
): ObjectRef[] {
  const candidates = new Set<ObjectRef>();
  const key = variableKey(guard.sourceVerbId, guard.variable);
  for (const binding of localBindingIndex.get(key) ?? []) {
    if (!isBefore(binding, guard) || !isControlFlowPrefix(binding, guard)) continue;
    const object = resolveLocalBindingObject(binding, coreBySymbol, objectMap);
    if (object) candidates.add(object);
  }
  for (const binding of objectFlowBindingIndex.get(key) ?? []) {
    if (!isBefore(binding, guard) || !isControlFlowPrefix(binding, guard)) continue;
    for (const object of binding.objects) candidates.add(object);
  }
  for (const binding of loopObjectBindingIndex.get(key) ?? []) {
    if (!isBefore(binding, guard) || !isControlFlowPrefix(binding, guard)) continue;
    for (const object of binding.objects) candidates.add(object);
  }
  if (candidates.size === 0) return [];
  return [...candidates].filter((object) => isObjectOrDescendantOf(object, targetObject, objectMap));
}

function isObjectOrDescendantOf(object: ObjectRef, ancestor: ObjectRef, objectMap: Map<ObjectRef, ExtractedObjectRecord>): boolean {
  return object === ancestor || collectAncestors(objectMap, object).ancestors.some((candidate) => candidate.object === ancestor);
}

function isControlFlowPrefix(
  left: Pick<KnownObjectBindingInput, "controlFlowPath">,
  right: Pick<KnownObjectBindingInput, "controlFlowPath">
): boolean {
  const leftPath = left.controlFlowPath ?? [];
  const rightPath = right.controlFlowPath ?? [];
  if (leftPath.length > rightPath.length) return false;
  return leftPath.every((segment, index) => rightPath[index] === segment);
}

function buildKnownValidGuardBindings(branchGuards: BranchGuardInput[]): KnownObjectBindingInput[] {
  const known: KnownObjectBindingInput[] = [];
  for (const guard of branchGuards) {
    if (guard.guardKind !== "valid" || !guard.variable || guard.guardScope === "conditional_expression") continue;
    known.push({
      sourceVerbId: guard.sourceVerbId,
      sourceObject: guard.sourceObject,
      sourcePath: guard.sourcePath,
      variable: guard.variable,
      valueKind: "runtime_object",
      provenance: guard.guardScope === "branch" ? "valid_guard" : "valid_exit_guard",
      confidence: "runtime",
      reason: "validated_runtime_object_receiver",
      sourceText: guard.guardText,
      line: guard.line,
      column: guard.column,
      ...controlFlowFields(guard)
    });
  }
  return known;
}

function buildKnownMatchFailureGuardBindings(branchGuards: BranchGuardInput[]): KnownObjectBindingInput[] {
  const known: KnownObjectBindingInput[] = [];
  for (const guard of branchGuards) {
    if (guard.guardKind !== "match_failure" || !guard.variable || guard.guardScope === "conditional_expression") continue;
    known.push({
      sourceVerbId: guard.sourceVerbId,
      sourceObject: guard.sourceObject,
      sourcePath: guard.sourcePath,
      variable: guard.variable,
      valueKind: "runtime_object",
      provenance: guard.guardScope === "branch" ? "match_failure_guard" : "match_failure_exit_guard",
      confidence: "runtime",
      reason: "runtime_object_receiver",
      sourceText: guard.guardText,
      line: guard.line,
      column: guard.column,
      ...controlFlowFields(guard)
    });
  }
  return known;
}

function resolveGuardTargetObject(
  guard: BranchGuardInput & { targetKind: "system_object" | "literal_object"; targetRaw: string },
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>
): ObjectRef | undefined {
  if (guard.targetKind === "literal_object") {
    return objectMap.has(guard.targetRaw as ObjectRef) ? (guard.targetRaw as ObjectRef) : undefined;
  }
  const candidate = coreBySymbol.get(coreSymbolKey(guard.targetRaw));
  if (candidate?.kind === "core_candidate" && objectMap.has(candidate.target)) return candidate.target;
  return undefined;
}

function localBindingProvenance(binding: LocalBindingInput): KnownObjectBindingInput["provenance"] {
  if (binding.bindingKind === "literal_object") return "literal_object_assignment";
  if (binding.bindingKind === "system_object") return "system_object_assignment";
  return "this_assignment";
}

function flattenObjectFlowBindings(
  index: Map<string, ObjectFlowBinding[]>,
  sources: Map<string, Pick<AssignmentInput, "sourceObject" | "sourcePath">>,
  fallbackKind: ObjectFlowBinding["bindingKind"]
): KnownObjectBindingInput[] {
  const known: KnownObjectBindingInput[] = [];
  for (const bindings of index.values()) {
    for (const binding of bindings) {
      const source = sources.get(binding.sourceVerbId);
      if (!source) continue;
      known.push({
        sourceVerbId: binding.sourceVerbId,
        sourceObject: source.sourceObject,
        sourcePath: source.sourcePath,
        variable: binding.variable,
        objects: binding.objects,
        valueKind: binding.objects.length === 1 ? "object" : "object_candidate_set",
        provenance:
          binding.provenance ??
          (fallbackKind === "object_property_assignment" ? "object_property_assignment" : "object_list_property_loop"),
        confidence: binding.objects.length === 1 ? "exact" : "candidate",
        line: binding.line,
        column: binding.column,
        ...controlFlowFields(binding)
      });
    }
  }
  return known;
}

function variableReceiverUses(callsites: CallsiteInput[], propertyAccesses: PropertyAccessInput[]): VariableUseInput[] {
  return [
    ...callsites
      .filter((callsite) => callsite.receiverKind === "variable")
      .map((callsite): VariableUseInput => ({
        sourceVerbId: callsite.sourceVerbId,
        sourceObject: callsite.sourceObject,
        sourcePath: callsite.sourcePath,
        useKind: "verb_call",
        receiverRaw: callsite.receiverRaw,
        sourceText: `${callsite.receiverRaw}:${callsite.selector ?? callsite.selectorExpression ?? ""}`,
        line: callsite.line,
        column: callsite.column,
        ...controlFlowFields(callsite)
      })),
    ...propertyAccesses
      .filter((access) => access.receiverKind === "variable")
      .map((access): VariableUseInput => ({
        sourceVerbId: access.sourceVerbId,
        sourceObject: access.sourceObject,
        sourcePath: access.sourcePath,
        useKind: "property_access",
        receiverRaw: access.receiverRaw,
        sourceText: access.property ? `${access.receiverRaw}.${access.property}` : `${access.receiverRaw}.(${access.propertyExpression ?? ""})`,
        line: access.line,
        column: access.column,
        ...controlFlowFields(access)
      }))
  ];
}

function controlFlowFields(input: {
  controlFlowKind?: KnownObjectBindingInput["controlFlowKind"];
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}): Pick<KnownObjectBindingInput, "controlFlowKind" | "controlFlowDepth" | "controlFlowPath"> {
  return {
    ...(input.controlFlowKind ? { controlFlowKind: input.controlFlowKind } : {}),
    ...(input.controlFlowDepth !== undefined ? { controlFlowDepth: input.controlFlowDepth } : {}),
    ...(input.controlFlowPath ? { controlFlowPath: input.controlFlowPath } : {})
  };
}

interface VerbCandidateMatch {
  verb: ExtractedVerbRecord;
  definedOn: ObjectRef;
  inheritanceDepth: number;
  inheritancePath: ObjectRef[];
}

interface AncestryObject {
  object: ObjectRef;
  depth: number;
  path: ObjectRef[];
}

interface ObjectFlowBinding {
  sourceVerbId: KnownObjectBindingInput["sourceVerbId"];
  variable: string;
  line: number;
  column: number;
  objects: ObjectRef[];
  bindingKind: "object_property_assignment" | "contents_loop";
  provenance?: KnownObjectBindingInput["provenance"];
  controlFlowKind?: KnownObjectBindingInput["controlFlowKind"];
  controlFlowDepth?: number;
  controlFlowPath?: string[];
}

type ReceiverObjectResolution =
  | { objects: ObjectRef[]; reason?: never; receiverObject?: never; resolutionKind: "single" | "contents_loop" }
  | { objects?: never; reason: UnresolvedRef["reason"]; receiverObject?: ObjectRef; resolutionKind?: never };

function findMatchingVerbs(
  verbIndex: Map<string, ExtractedVerbRecord[]>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  object: ObjectRef,
  selector: string
): { matches: VerbCandidateMatch[]; cycleDetected: boolean } {
  const direct = findMatchingVerbsOnObject(verbIndex, object, selector, 0);
  if (direct.length > 0) return { matches: direct, cycleDetected: false };

  const ancestry = collectAncestors(objectMap, object);
  const matches: VerbCandidateMatch[] = [];
  for (const ancestor of ancestry.ancestors) {
    matches.push(...findMatchingVerbsOnObject(verbIndex, ancestor.object, selector, ancestor.depth, ancestor.path));
  }

  return { matches, cycleDetected: ancestry.cycleDetected };
}

function findMatchingVerbsOnObject(
  verbIndex: Map<string, ExtractedVerbRecord[]>,
  object: ObjectRef,
  selector: string,
  inheritanceDepth: number,
  inheritancePath: ObjectRef[] = [object]
): VerbCandidateMatch[] {
  return (verbIndex.get(object) ?? [])
    .filter((verb) => verb.names.some((name) => matchesVerbName(name, selector)))
    .map((verb) => ({ verb, definedOn: object, inheritanceDepth, inheritancePath }));
}

interface PropertyCandidateMatch {
  property: ExtractedPropertyDefinitionRecord;
  definedOn: ObjectRef;
  inheritanceDepth: number;
  inheritancePath: ObjectRef[];
}

function findMatchingProperties(
  propertyIndex: Map<string, ExtractedPropertyDefinitionRecord[]>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  object: ObjectRef,
  propertyName: string
): { matches: PropertyCandidateMatch[]; cycleDetected: boolean } {
  const direct = findMatchingPropertiesOnObject(propertyIndex, object, propertyName, 0);
  if (direct.length > 0) return { matches: direct, cycleDetected: false };

  const ancestry = collectAncestors(objectMap, object);
  const matches: PropertyCandidateMatch[] = [];
  for (const ancestor of ancestry.ancestors) {
    matches.push(...findMatchingPropertiesOnObject(propertyIndex, ancestor.object, propertyName, ancestor.depth, ancestor.path));
  }

  return { matches, cycleDetected: ancestry.cycleDetected };
}

function findMatchingPropertiesOnObject(
  propertyIndex: Map<string, ExtractedPropertyDefinitionRecord[]>,
  object: ObjectRef,
  propertyName: string,
  inheritanceDepth: number,
  inheritancePath: ObjectRef[] = [object]
): PropertyCandidateMatch[] {
  return (propertyIndex.get(object) ?? [])
    .filter((property) => property.name.toLowerCase() === propertyName.toLowerCase())
    .map((property) => ({ property, definedOn: object, inheritanceDepth, inheritancePath }));
}

function buildRootFunctionCallKeySet(functionCalls: FunctionCallInput[]): Set<string> {
  return new Set(functionCalls.filter((call) => isRootFunctionName(call.function)).map(rootFunctionCallKey));
}

function rootFunctionCallKey(call: Pick<FunctionCallInput, "sourceVerbId" | "function" | "line" | "column">): string {
  return `${call.sourceVerbId}\t${call.line}\t${call.column}\t${call.function.toLowerCase()}`;
}

function systemRefKey(ref: Pick<SystemObjectRefInput, "sourceVerbId" | "symbol" | "line" | "column">): string {
  return `${ref.sourceVerbId}\t${ref.line}\t${ref.column}\t${ref.symbol.toLowerCase()}`;
}

function isRootFunctionName(functionName: string): boolean {
  return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(functionName);
}

function rootNameFromSymbol(symbol: string): string {
  return symbol.startsWith("$") ? symbol.slice(1) : symbol;
}

function findRootProperty(
  propertyIndex: Map<string, ExtractedPropertyDefinitionRecord[]>,
  symbol: string
): ExtractedPropertyDefinitionRecord | undefined {
  const propertyName = rootNameFromSymbol(symbol);
  return (propertyIndex.get("#0") ?? []).find((property) => property.name.toLowerCase() === propertyName.toLowerCase());
}

function collectAncestors(
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  object: ObjectRef
): { ancestors: AncestryObject[]; cycleDetected: boolean } {
  const ancestors: AncestryObject[] = [];
  const visited = new Set<ObjectRef>([object]);
  const queued = new Set<ObjectRef>();
  const queue = getParentRefs(objectMap.get(object)).map((parent) => ({ object: parent, depth: 1, path: [object, parent] }));
  for (const parent of queue) queued.add(parent.object);
  let cycleDetected = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    queued.delete(current.object);

    if (visited.has(current.object)) {
      cycleDetected = true;
      continue;
    }

    visited.add(current.object);
    const currentRecord = objectMap.get(current.object);
    if (!currentRecord) continue;

    ancestors.push(current);

    for (const parent of getParentRefs(currentRecord)) {
      if (visited.has(parent)) {
        cycleDetected = true;
        continue;
      }
      if (!queued.has(parent)) {
        queue.push({ object: parent, depth: current.depth + 1, path: [...current.path, parent] });
        queued.add(parent);
      }
    }
  }

  return { ancestors, cycleDetected };
}

function getParentRefs(object: ExtractedObjectRecord | undefined): ObjectRef[] {
  if (!object) return [];
  return object.parents.filter((parent): parent is ObjectRef => typeof parent === "string" && parent !== "#-1");
}

function resolveSystemObjectRefs(
  refs: SystemObjectRefInput[],
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectIds: Set<string>,
  propertyIndex: Map<string, ExtractedPropertyDefinitionRecord[]>,
  rootFunctionCallKeys: Set<string>,
  sourceVerbNames: Map<string, string>
): Pick<ResolvedEdges, "systemObjectEdges" | "rootPropertyEdges" | "unresolvedRefs"> {
  const systemObjectEdges: SystemObjectEdge[] = [];
  const rootPropertyEdges: RootPropertyEdge[] = [];
  const unresolvedRefs: UnresolvedRef[] = [];

  for (const ref of refs) {
    const candidate = coreBySymbol.get(coreSymbolKey(ref.symbol));
    if (candidate?.kind === "core_candidate" && objectIds.has(candidate.target)) {
      systemObjectEdges.push({
        kind: "system_object_edge",
        sourceVerbId: ref.sourceVerbId,
        sourceObject: ref.sourceObject,
        sourcePath: ref.sourcePath,
        line: ref.line,
        column: ref.column,
        symbol: ref.symbol,
        targetObject: candidate.target,
        resolutionKind: "core_candidate",
        confidence: candidate.confidence,
        context: ref.context
      });
      continue;
    }

    if (rootFunctionCallKeys.has(systemRefKey(ref))) continue;

    const rootProperty = findRootProperty(propertyIndex, ref.symbol);
    if (rootProperty) {
      rootPropertyEdges.push({
        kind: "root_property_edge",
        sourceVerbId: ref.sourceVerbId,
        sourceObject: ref.sourceObject,
        sourcePath: ref.sourcePath,
        line: ref.line,
        column: ref.column,
        sourceVerbName: sourceVerbNameFor(sourceVerbNames, ref.sourceVerbId),
        symbol: ref.symbol,
        property: rootProperty.name,
        targetObject: "#0",
        definedOn: "#0",
        propertyId: rootProperty.id,
        definitionIndex: rootProperty.definitionIndex,
        accessKind: ref.context === "assignment_left" ? "write" : ref.context === "assignment_right" ? "read" : "expression",
        resolutionKind: "root_property",
        confidence: "exact",
        context: ref.context
      });
      continue;
    }

    if (!candidate) {
      unresolvedRefs.push(unresolvedSystemObject(ref, "no_core_candidate", sourceVerbNames));
    } else if (candidate.kind !== "core_candidate") {
      unresolvedRefs.push(unresolvedSystemObject(ref, "core_collection_candidate", sourceVerbNames));
    } else {
      unresolvedRefs.push(unresolvedSystemObject(ref, "core_candidate_missing_target_object", sourceVerbNames, candidate.target));
    }
  }

  return { systemObjectEdges, rootPropertyEdges, unresolvedRefs };
}

function resolveLiteralObjectRefs(
  refs: ObjectRefInput[],
  objectIds: Set<string>,
  sourceVerbNames: Map<string, string>
): Pick<ResolvedEdges, "literalObjectEdges" | "unresolvedRefs"> {
  const literalObjectEdges: LiteralObjectEdge[] = [];
  const unresolvedRefs: UnresolvedRef[] = [];

  for (const ref of refs) {
    const specialName = specialLiteralObjectName(ref.object);
    if (specialName) {
      literalObjectEdges.push({
        kind: "literal_object_edge",
        sourceVerbId: ref.sourceVerbId,
        sourceObject: ref.sourceObject,
        sourcePath: ref.sourcePath,
        line: ref.line,
        column: ref.column,
        object: ref.object,
        targetObject: ref.object as ObjectRef,
        resolutionKind: "special_literal_object",
        specialName,
        context: ref.context
      });
      continue;
    }

    if (!objectIds.has(ref.object)) {
      unresolvedRefs.push({
        kind: "unresolved_ref",
        sourceVerbId: ref.sourceVerbId,
        sourceObject: ref.sourceObject,
        sourcePath: ref.sourcePath,
        line: ref.line,
        column: ref.column,
        sourceVerbName: sourceVerbNameFor(sourceVerbNames, ref.sourceVerbId),
        refKind: "literal_object",
        ref: ref.object,
        reason: "missing_object",
        context: ref.context
      });
      continue;
    }
    literalObjectEdges.push({
      kind: "literal_object_edge",
      sourceVerbId: ref.sourceVerbId,
      sourceObject: ref.sourceObject,
      sourcePath: ref.sourcePath,
      line: ref.line,
      column: ref.column,
      object: ref.object,
      targetObject: ref.object as ObjectRef,
      resolutionKind: "literal_object",
      context: ref.context
    });
  }

  return { literalObjectEdges, unresolvedRefs };
}

function specialLiteralObjectName(object: string): LiteralObjectEdge["specialName"] | undefined {
  if (object === "#-1") return "$nothing";
  if (object === "#-2") return "$ambiguous_match";
  if (object === "#-3") return "$failed_match";
  return undefined;
}

async function resolveVerbCallCandidates(
  callsites: CallsiteInput[],
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  verbIndex: Map<string, ExtractedVerbRecord[]>,
  sourceVerbNames: Map<string, string>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>,
  loopObjectBindingIndex: Map<string, ObjectFlowBinding[]>,
  flowAnalysis: LocalFlowAnalysis,
  branchGuards: BranchGuardInput[],
  sourceLines: SourceLineCache
): Promise<Pick<ResolvedEdges, "verbCallCandidateEdges" | "guardedVerbCallEdges" | "unresolvedRefs"> & { staticVerbCallsiteCount: number }> {
  const verbCallCandidateEdges: VerbCallCandidateEdge[] = [];
  const guardedVerbCallEdges: GuardedVerbCallEdge[] = [];
  const unresolvedRefs: UnresolvedRef[] = [];
  const hasVerbGuards = branchGuards.filter(isHasVerbGuard);
  let staticVerbCallsiteCount = 0;

  for (const callsite of callsites) {
    if (callsite.selectorKind !== "static" || !callsite.selector) {
      continue;
    }
    if (
      callsite.receiverKind !== "system_object" &&
      callsite.receiverKind !== "literal_object" &&
      callsite.receiverKind !== "this" &&
      callsite.receiverKind !== "variable"
    ) {
      continue;
    }
    const receiverObjects = resolveCallReceiverObjects(
      callsite,
      coreBySymbol,
      objectMap,
      localBindingIndex,
      destructuringBindingIndex,
      loopBindingIndex,
      objectFlowBindingIndex,
      loopObjectBindingIndex,
      flowAnalysis
    );
    if (!receiverObjects.objects) {
      const guarded = guardedVerbCallEdge(callsite, hasVerbGuards, sourceVerbNames, receiverObjects.receiverObject);
      if (guarded) {
        staticVerbCallsiteCount += 1;
        guardedVerbCallEdges.push(guarded);
        continue;
      }
      if (callsite.receiverKind === "variable") continue;
      staticVerbCallsiteCount += 1;
      unresolvedRefs.push(unresolvedVerbCall(callsite, receiverObjects.reason, sourceVerbNames, receiverObjects.receiverObject));
      continue;
    }
    staticVerbCallsiteCount += 1;

    const candidateResults = receiverObjects.objects.map((object) => ({ object, result: findMatchingVerbs(verbIndex, objectMap, object, callsite.selector!) }));
    const matches = candidateResults.flatMap(({ result }) => result.matches);
    if (matches.length === 0) {
      const guarded = guardedVerbCallEdge(
        callsite,
        hasVerbGuards,
        sourceVerbNames,
        receiverObjects.objects.length === 1 ? receiverObjects.objects[0] : undefined
      );
      if (guarded) {
        guardedVerbCallEdges.push(guarded);
        continue;
      }
      unresolvedRefs.push(
        unresolvedVerbCall(
          callsite,
          candidateResults.some(({ result }) => result.cycleDetected)
            ? "ancestor_cycle"
            : noMatchingVerbReason(receiverObjects.resolutionKind),
          sourceVerbNames,
          receiverObjects.objects.length === 1 ? receiverObjects.objects[0] : undefined,
          await optionalFeatureHookMetadata(callsite, receiverObjects.objects, objectMap, flowAnalysis, sourceLines)
        )
      );
      continue;
    }

    for (const candidate of matches) {
      verbCallCandidateEdges.push({
        kind: "verb_call_candidate_edge",
        sourceVerbId: callsite.sourceVerbId,
        sourceObject: callsite.sourceObject,
        sourcePath: callsite.sourcePath,
        line: callsite.line,
        column: callsite.column,
        sourceVerbName: sourceVerbNameFor(sourceVerbNames, callsite.sourceVerbId),
        receiverKind: callsite.receiverKind,
        receiverRaw: callsite.receiverRaw,
        receiverObject: candidate.inheritancePath[0]!,
        selector: callsite.selector,
        targetObject: candidate.definedOn,
        definedOn: candidate.definedOn,
        inheritanceDepth: candidate.inheritanceDepth,
        inheritancePath: candidate.inheritancePath,
        targetVerbId: candidate.verb.id,
        resolutionKind: detectVerbCallResolutionKind(callsite.receiverKind, candidate.inheritanceDepth),
        confidence: "candidate"
      });
    }
  }

  return { verbCallCandidateEdges, guardedVerbCallEdges, unresolvedRefs, staticVerbCallsiteCount };
}

function resolveRootVerbFunctionCalls(
  functionCalls: FunctionCallInput[],
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  verbIndex: Map<string, ExtractedVerbRecord[]>,
  sourceVerbNames: Map<string, string>
): Pick<ResolvedEdges, "rootVerbCallEdges" | "unresolvedRefs"> & { rootVerbFunctionCallCount: number } {
  const rootVerbCallEdges: RootVerbCallEdge[] = [];
  const unresolvedRefs: UnresolvedRef[] = [];
  const rootCalls = functionCalls.filter((call) => isRootFunctionName(call.function));

  for (const call of rootCalls) {
    const selector = rootNameFromSymbol(call.function);
    const result = findMatchingVerbs(verbIndex, objectMap, "#0", selector);
    if (result.matches.length === 0) {
      unresolvedRefs.push({
        kind: "unresolved_ref",
        sourceVerbId: call.sourceVerbId,
        sourceObject: call.sourceObject,
        sourcePath: call.sourcePath,
        line: call.line,
        column: call.column,
        sourceVerbName: sourceVerbNameFor(sourceVerbNames, call.sourceVerbId),
        refKind: "verb_call",
        ref: call.function,
        reason: result.cycleDetected ? "ancestor_cycle" : "no_matching_direct_or_inherited_verb",
        receiverRaw: "#0",
        receiverObject: "#0",
        selector,
        ...(call.inlineErrorHandled !== undefined ? { inlineErrorHandled: call.inlineErrorHandled } : {}),
        ...(call.inlineErrorCodes ? { inlineErrorCodes: call.inlineErrorCodes } : {}),
        ...(call.inlineErrorFallbackText ? { inlineErrorFallbackText: call.inlineErrorFallbackText } : {}),
        ...(call.inlineErrorExpressionText ? { inlineErrorExpressionText: call.inlineErrorExpressionText } : {})
      });
      continue;
    }

    for (const match of result.matches) {
      rootVerbCallEdges.push({
        kind: "root_verb_call_edge",
        sourceVerbId: call.sourceVerbId,
        sourceObject: call.sourceObject,
        sourcePath: call.sourcePath,
        line: call.line,
        column: call.column,
        sourceVerbName: sourceVerbNameFor(sourceVerbNames, call.sourceVerbId),
        function: call.function,
        selector,
        argumentsText: call.argumentsText,
        targetObject: "#0",
        definedOn: match.definedOn,
        inheritanceDepth: match.inheritanceDepth,
        inheritancePath: match.inheritancePath,
        targetVerbId: match.verb.id,
        resolutionKind: match.inheritanceDepth === 0 ? "root_verb_function_call" : "inherited_root_verb_function_call",
        confidence: "candidate",
        ...(call.inlineErrorHandled !== undefined ? { inlineErrorHandled: call.inlineErrorHandled } : {}),
        ...(call.inlineErrorCodes ? { inlineErrorCodes: call.inlineErrorCodes } : {}),
        ...(call.inlineErrorFallbackText ? { inlineErrorFallbackText: call.inlineErrorFallbackText } : {}),
        ...(call.inlineErrorExpressionText ? { inlineErrorExpressionText: call.inlineErrorExpressionText } : {})
      });
    }
  }

  return { rootVerbCallEdges, unresolvedRefs, rootVerbFunctionCallCount: rootCalls.length };
}

const BUILT_IN_PROPERTIES = new Set(["name", "owner", "programmer", "wizard", "r", "w", "f", "a", "location", "last_move", "contents"]);

async function resolvePropertyAccesses(
  propertyAccesses: PropertyAccessInput[],
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  propertyIndex: Map<string, ExtractedPropertyDefinitionRecord[]>,
  verbById: Map<string, ExtractedVerbRecord>,
  propertyValueIndex: Map<string, ExtractedPropertyValueRecord>,
  propertyAccessTextIndex: Map<string, PropertyAccessInput[]>,
  sourceVerbNames: Map<string, string>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>,
  loopObjectBindingIndex: Map<string, ObjectFlowBinding[]>,
  flowAnalysis: LocalFlowAnalysis,
  branchGuards: BranchGuardInput[],
  sourceLines: SourceLineCache
): Promise<
  Pick<ResolvedEdges, "propertyCandidateEdges" | "guardedPropertyAccessEdges" | "unresolvedPropertyAccessFindings"> & { staticPropertyAccessCount: number }
> {
  const propertyCandidateEdges: PropertyCandidateEdge[] = [];
  const guardedPropertyAccessEdges: GuardedPropertyAccessEdge[] = [];
  const unresolvedPropertyAccessFindings: UnresolvedPropertyAccessFinding[] = [];
  const hasPropertyGuards = branchGuards.filter(isHasPropertyGuard);
  const isaPropertyGuards = branchGuards.filter(isIsaPropertyGuard);
  const validGuards = branchGuards.filter(isValidGuard);
  let staticPropertyAccessCount = 0;

  for (const access of propertyAccesses) {
    if (access.propertyKind !== "static" || !access.property) {
      const aliasResolution = resolveThisVerbAliasPropertyAccess(access, verbById, objectMap, propertyIndex, sourceVerbNames, sourceLines);
      if (aliasResolution) {
        propertyCandidateEdges.push(...aliasResolution.propertyCandidateEdges);
        if (aliasResolution.unresolvedPropertyAccessFinding) unresolvedPropertyAccessFindings.push(await aliasResolution.unresolvedPropertyAccessFinding);
        continue;
      }
      const loopResolution = resolvePropertiesLoopComputedPropertyAccess(
        access,
        coreBySymbol,
        objectMap,
        propertyIndex,
        sourceVerbNames,
        localBindingIndex,
        destructuringBindingIndex,
        loopBindingIndex,
        objectFlowBindingIndex,
        loopObjectBindingIndex
      );
      if (loopResolution) {
        propertyCandidateEdges.push(...loopResolution.propertyCandidateEdges);
        continue;
      }
      unresolvedPropertyAccessFindings.push(await unresolvedPropertyAccess(access, "dynamic_property", sourceVerbNames, sourceLines));
      continue;
    }

    if (isKnownRuntimeObjectFunctionReceiver(access.receiverRaw)) {
      unresolvedPropertyAccessFindings.push(
        await unresolvedPropertyAccess(access, "runtime_object_function_receiver", sourceVerbNames, sourceLines)
      );
      continue;
    }

    if (
      access.receiverKind !== "system_object" &&
      access.receiverKind !== "literal_object" &&
      access.receiverKind !== "this" &&
      access.receiverKind !== "variable" &&
      access.receiverKind !== "property_access"
    ) {
      unresolvedPropertyAccessFindings.push(
        await unresolvedPropertyAccess(access, unsupportedPropertyReceiverReason(access), sourceVerbNames, sourceLines)
      );
      continue;
    }

    staticPropertyAccessCount += 1;

    const receiverObjects = resolvePropertyReceiverObjects(
      access,
      coreBySymbol,
      objectMap,
      propertyValueIndex,
      propertyAccessTextIndex,
      localBindingIndex,
      destructuringBindingIndex,
      loopBindingIndex,
      objectFlowBindingIndex,
      loopObjectBindingIndex,
      flowAnalysis
    );
    if (!receiverObjects.objects) {
      if (validGuardAppliesToPropertyAccess(validGuards, access)) {
        unresolvedPropertyAccessFindings.push(
          await unresolvedPropertyAccess(access, "validated_runtime_object_receiver", sourceVerbNames, sourceLines)
        );
        continue;
      }
      const guarded = guardedPropertyAccessEdge(access, hasPropertyGuards, sourceVerbNames);
      if (guarded) {
        guardedPropertyAccessEdges.push(guarded);
        continue;
      }
      const isaGuarded = isaGuardedPropertyAccessEdge(access, isaPropertyGuards, sourceVerbNames);
      if (isaGuarded) {
        guardedPropertyAccessEdges.push(isaGuarded);
        continue;
      }
      unresolvedPropertyAccessFindings.push(
        await unresolvedPropertyAccess(access, receiverObjects.reason, sourceVerbNames, sourceLines, receiverObjects.receiverObject)
      );
      continue;
    }

    if (BUILT_IN_PROPERTIES.has(access.property.toLowerCase())) {
      for (const receiverObject of receiverObjects.objects) {
        propertyCandidateEdges.push({
          kind: "property_candidate_edge",
          sourceVerbId: access.sourceVerbId,
          sourceVerbName: sourceVerbNameFor(sourceVerbNames, access.sourceVerbId),
          sourceObject: access.sourceObject,
          sourcePath: access.sourcePath,
          line: access.line,
          column: access.column,
          accessKind: access.accessKind,
          receiverKind: access.receiverKind,
          receiverRaw: access.receiverRaw,
          receiverObject,
          property: access.property,
          targetObject: receiverObject,
          definedOn: "builtin",
          inheritanceDepth: 0,
          inheritancePath: [receiverObject],
          propertyId: `builtin:${access.property.toLowerCase()}`,
          resolutionKind: access.receiverKind === "property_access" ? "chained_property_receiver" : "built_in_property",
          confidence: "candidate"
        });
      }
      continue;
    }

    const candidateResults = receiverObjects.objects.map((object) => ({ object, result: findMatchingProperties(propertyIndex, objectMap, object, access.property!) }));
    const matches = candidateResults.flatMap(({ result }) => result.matches);
    if (matches.length === 0) {
      const guarded = guardedPropertyAccessEdge(
        access,
        hasPropertyGuards,
        sourceVerbNames,
        receiverObjects.objects.length === 1 ? receiverObjects.objects[0] : undefined
      );
      if (guarded) {
        guardedPropertyAccessEdges.push(guarded);
        continue;
      }
      const isaGuarded = isaGuardedPropertyAccessEdge(
        access,
        isaPropertyGuards,
        sourceVerbNames,
        receiverObjects.objects.length === 1 ? receiverObjects.objects[0] : undefined
      );
      if (isaGuarded) {
        guardedPropertyAccessEdges.push(isaGuarded);
        continue;
      }
      unresolvedPropertyAccessFindings.push(
        await unresolvedPropertyAccess(
          access,
          candidateResults.some(({ result }) => result.cycleDetected)
            ? "ancestor_cycle"
            : noMatchingPropertyReason(receiverObjects.resolutionKind),
          sourceVerbNames,
          sourceLines,
          receiverObjects.objects.length === 1 ? receiverObjects.objects[0] : undefined
        )
      );
      continue;
    }

    for (const candidate of matches) {
      propertyCandidateEdges.push({
        kind: "property_candidate_edge",
        sourceVerbId: access.sourceVerbId,
        sourceVerbName: sourceVerbNameFor(sourceVerbNames, access.sourceVerbId),
        sourceObject: access.sourceObject,
        sourcePath: access.sourcePath,
        line: access.line,
        column: access.column,
        accessKind: access.accessKind,
        receiverKind: access.receiverKind,
        receiverRaw: access.receiverRaw,
        receiverObject: candidate.inheritancePath[0]!,
        property: access.property,
        targetObject: candidate.definedOn,
        definedOn: candidate.definedOn,
        inheritanceDepth: candidate.inheritanceDepth,
        inheritancePath: candidate.inheritancePath,
        propertyId: candidate.property.id,
        definitionIndex: candidate.property.definitionIndex,
        resolutionKind:
          access.receiverKind === "property_access"
            ? "chained_property_receiver"
            : detectPropertyResolutionKind(access.receiverKind, candidate.inheritanceDepth),
        confidence: "candidate"
      });
    }
  }

  return { propertyCandidateEdges, guardedPropertyAccessEdges, unresolvedPropertyAccessFindings, staticPropertyAccessCount };
}

function resolveThisVerbAliasPropertyAccess(
  access: PropertyAccessInput,
  verbById: Map<string, ExtractedVerbRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  propertyIndex: Map<string, ExtractedPropertyDefinitionRecord[]>,
  sourceVerbNames: Map<string, string>,
  sourceLines: SourceLineCache
): { propertyCandidateEdges: PropertyCandidateEdge[]; unresolvedPropertyAccessFinding?: Promise<UnresolvedPropertyAccessFinding> } | undefined {
  if (access.receiverKind !== "this" || access.receiverRaw.toLowerCase() !== "this") return undefined;
  if (access.propertyKind !== "computed" || access.propertyExpression?.toLowerCase() !== "verb") return undefined;

  const verb = verbById.get(access.sourceVerbId);
  const possibleProperties = verb?.names?.filter((name): name is string => typeof name === "string" && name.length > 0) ?? [];
  if (possibleProperties.length === 0 || possibleProperties.some((name) => name.includes("*"))) return undefined;
  if (!objectMap.has(access.sourceObject)) return undefined;

  const propertyCandidateEdges: PropertyCandidateEdge[] = [];
  const missingProperties: string[] = [];
  let cycleDetected = false;
  for (const property of possibleProperties) {
    if (BUILT_IN_PROPERTIES.has(property.toLowerCase())) {
      propertyCandidateEdges.push(thisVerbAliasBuiltInPropertyEdge(access, property, sourceVerbNames, possibleProperties));
      continue;
    }

    const result = findMatchingProperties(propertyIndex, objectMap, access.sourceObject, property);
    cycleDetected ||= result.cycleDetected;
    if (result.matches.length === 0) {
      missingProperties.push(property);
      continue;
    }
    for (const candidate of result.matches) {
      propertyCandidateEdges.push(thisVerbAliasPropertyEdge(access, property, candidate, sourceVerbNames, possibleProperties));
    }
  }

  if (propertyCandidateEdges.length === 0 && missingProperties.length === possibleProperties.length && cycleDetected) return undefined;
  return {
    propertyCandidateEdges,
    ...(missingProperties.length > 0
      ? {
          unresolvedPropertyAccessFinding: unresolvedPropertyAccess(
            access,
            cycleDetected && propertyCandidateEdges.length === 0 ? "ancestor_cycle" : "no_matching_property",
            sourceVerbNames,
            sourceLines,
            access.sourceObject,
            { possibleProperties, missingProperties }
          )
        }
      : {})
  };
}

function resolvePropertiesLoopComputedPropertyAccess(
  access: PropertyAccessInput,
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  propertyIndex: Map<string, ExtractedPropertyDefinitionRecord[]>,
  sourceVerbNames: Map<string, string>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>,
  loopObjectBindingIndex: Map<string, ObjectFlowBinding[]>
): { propertyCandidateEdges: PropertyCandidateEdge[] } | undefined {
  if (access.propertyKind !== "computed" || !access.propertyExpression) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(access.propertyExpression)) return undefined;
  const loop = matchingPropertiesLoop(access, loopBindingIndex);
  if (!loop) return undefined;

  const target = propertiesLoopTargetObject(
    loop,
    coreBySymbol,
    objectMap,
    localBindingIndex,
    destructuringBindingIndex,
    loopBindingIndex,
    objectFlowBindingIndex,
    loopObjectBindingIndex
  );
  if (!target) return undefined;

  const receiverObjects = resolveReceiverObjects(
    access,
    coreBySymbol,
    objectMap,
    localBindingIndex,
    destructuringBindingIndex,
    loopBindingIndex,
    objectFlowBindingIndex,
    loopObjectBindingIndex
  );
  if (!receiverObjects.objects?.some((object) => object === target)) return undefined;

  const possibleProperties = propertiesDefinedOnObject(propertyIndex, target);
  if (possibleProperties.length === 0) return undefined;

  return {
    propertyCandidateEdges: possibleProperties.map((property) =>
      computedPropertiesLoopPropertyEdge(access, property, target, sourceVerbNames)
    )
  };
}

function matchingPropertiesLoop(access: PropertyAccessInput, loopBindingIndex: Map<string, LoopBindingInput[]>): LoopBindingInput | undefined {
  if (!access.propertyExpression) return undefined;
  const key = variableKey(access.sourceVerbId, access.propertyExpression);
  return (loopBindingIndex.get(key) ?? [])
    .filter((loop) => isBefore(loop, access) && isControlFlowPrefix(loop, access))
    .reverse()
    .find((loop) => /^properties\s*\(/i.test(stripBalancedParens(loop.collectionText)));
}

function propertiesLoopTargetObject(
  loop: LoopBindingInput,
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>,
  loopObjectBindingIndex: Map<string, ObjectFlowBinding[]>
): ObjectRef | undefined {
  const match = /^properties\s*\((.*)\)$/i.exec(stripBalancedParens(loop.collectionText));
  if (!match) return undefined;
  const argument = receiverInputFromText(stripBalancedParens(match[1] ?? ""), loop);
  if (!argument) return undefined;
  const receiverObjects = resolveReceiverObjects(
    argument,
    coreBySymbol,
    objectMap,
    localBindingIndex,
    destructuringBindingIndex,
    loopBindingIndex,
    objectFlowBindingIndex,
    loopObjectBindingIndex
  );
  return receiverObjects.objects?.length === 1 ? receiverObjects.objects[0] : undefined;
}

function propertiesDefinedOnObject(
  propertyIndex: Map<string, ExtractedPropertyDefinitionRecord[]>,
  object: ObjectRef
): ExtractedPropertyDefinitionRecord[] {
  return [...(propertyIndex.get(object) ?? [])].sort(
    (left, right) => (left.definitionIndex ?? 0) - (right.definitionIndex ?? 0) || left.name.localeCompare(right.name)
  );
}

function computedPropertiesLoopPropertyEdge(
  access: PropertyAccessInput,
  property: ExtractedPropertyDefinitionRecord,
  receiverObject: ObjectRef,
  sourceVerbNames: Map<string, string>
): PropertyCandidateEdge {
  return {
    kind: "property_candidate_edge",
    sourceVerbId: access.sourceVerbId,
    sourceVerbName: sourceVerbNameFor(sourceVerbNames, access.sourceVerbId),
    sourceObject: access.sourceObject,
    sourcePath: access.sourcePath,
    line: access.line,
    column: access.column,
    accessKind: access.accessKind,
    receiverKind: access.receiverKind,
    receiverRaw: access.receiverRaw,
    receiverObject,
    property: property.name,
    propertyExpression: access.propertyExpression,
    targetObject: property.object,
    definedOn: property.object,
    inheritanceDepth: 0,
    inheritancePath: [receiverObject],
    propertyId: property.id,
    definitionIndex: property.definitionIndex,
    resolutionKind: "computed_properties_loop_property",
    confidence: "candidate"
  };
}

function thisVerbAliasBuiltInPropertyEdge(
  access: PropertyAccessInput,
  property: string,
  sourceVerbNames: Map<string, string>,
  possibleProperties: string[]
): PropertyCandidateEdge {
  return {
    kind: "property_candidate_edge",
    sourceVerbId: access.sourceVerbId,
    sourceVerbName: sourceVerbNameFor(sourceVerbNames, access.sourceVerbId),
    sourceObject: access.sourceObject,
    sourcePath: access.sourcePath,
    line: access.line,
    column: access.column,
    accessKind: access.accessKind,
    receiverKind: access.receiverKind,
    receiverRaw: access.receiverRaw,
    receiverObject: access.sourceObject,
    property,
    propertyExpression: access.propertyExpression,
    possibleProperties,
    targetObject: access.sourceObject,
    definedOn: "builtin",
    inheritanceDepth: 0,
    inheritancePath: [access.sourceObject],
    propertyId: `builtin:${property.toLowerCase()}`,
    resolutionKind: "this_verb_alias_property",
    confidence: "candidate"
  };
}

function thisVerbAliasPropertyEdge(
  access: PropertyAccessInput,
  property: string,
  candidate: PropertyCandidateMatch,
  sourceVerbNames: Map<string, string>,
  possibleProperties: string[]
): PropertyCandidateEdge {
  return {
    kind: "property_candidate_edge",
    sourceVerbId: access.sourceVerbId,
    sourceVerbName: sourceVerbNameFor(sourceVerbNames, access.sourceVerbId),
    sourceObject: access.sourceObject,
    sourcePath: access.sourcePath,
    line: access.line,
    column: access.column,
    accessKind: access.accessKind,
    receiverKind: access.receiverKind,
    receiverRaw: access.receiverRaw,
    receiverObject: candidate.inheritancePath[0]!,
    property,
    propertyExpression: access.propertyExpression,
    possibleProperties,
    targetObject: candidate.definedOn,
    definedOn: candidate.definedOn,
    inheritanceDepth: candidate.inheritanceDepth,
    inheritancePath: candidate.inheritancePath,
    propertyId: candidate.property.id,
    definitionIndex: candidate.property.definitionIndex,
    resolutionKind: candidate.inheritanceDepth === 0 ? "this_verb_alias_property" : "this_inherited_verb_alias_property",
    confidence: "candidate"
  };
}

function resolvePropertyReceiverObject(
  access: PropertyAccessInput,
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  propertyValueIndex: Map<string, ExtractedPropertyValueRecord>,
  propertyAccessTextIndex: Map<string, PropertyAccessInput[]>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>,
  loopObjectBindingIndex: Map<string, ObjectFlowBinding[]>,
  flowAnalysis?: LocalFlowAnalysis
):
  | { object: ObjectRef; reason?: never; receiverObject?: never }
  | { object?: never; reason: UnresolvedRef["reason"]; receiverObject?: ObjectRef } {
  if (access.receiverKind !== "property_access") {
    const receiverObjects = resolveReceiverObjects(
      access,
      coreBySymbol,
      objectMap,
      localBindingIndex,
      destructuringBindingIndex,
      loopBindingIndex,
      objectFlowBindingIndex,
      loopObjectBindingIndex,
      flowAnalysis
    );
    if (receiverObjects.objects?.length === 1) return { object: receiverObjects.objects[0]! };
    return { reason: receiverObjects.reason ?? "property_receiver", receiverObject: receiverObjects.receiverObject };
  }

  if (flowAnalysis) {
    const state = flowAnalysis.lookupVariableState({
      sourceVerbId: access.sourceVerbId,
      sourceObject: access.sourceObject,
      sourcePath: access.sourcePath,
      receiverRaw: access.receiverRaw,
      line: access.line,
      column: access.column,
      ...(access.controlFlowPath ? { controlFlowPath: access.controlFlowPath } : {})
    });
    if (state?.objects?.length === 1 && objectMap.has(state.objects[0]!)) return { object: state.objects[0]! };
  }

  const inner = findPropertyAccessByText(propertyAccessTextIndex, access.sourceVerbId, access.receiverRaw, access);
  if (!inner || inner.propertyKind !== "static" || !inner.property) return { reason: "property_receiver" };

  const innerReceiver = resolvePropertyReceiverObject(
    inner,
    coreBySymbol,
    objectMap,
    propertyValueIndex,
    propertyAccessTextIndex,
    localBindingIndex,
    destructuringBindingIndex,
    loopBindingIndex,
    objectFlowBindingIndex,
    loopObjectBindingIndex,
    flowAnalysis
  );
  if (!innerReceiver.object) return { reason: propertyChainReceiverReason(innerReceiver.reason), receiverObject: innerReceiver.receiverObject };

  const objectValue = resolveObjectValuedProperty(innerReceiver.object, inner.property, objectMap, propertyValueIndex)[0];
  if (!objectValue || !objectMap.has(objectValue)) return { reason: "property_receiver" };

  return { object: objectValue };
}

function propertyChainReceiverReason(reason: UnresolvedRef["reason"]): UnresolvedRef["reason"] {
  return isRuntimeReceiverReason(reason) ? "runtime_property_chain_receiver" : reason;
}

function isRuntimeReceiverReason(reason: UnresolvedRef["reason"]): boolean {
  return (
    reason === "player_receiver" ||
    reason === "caller_receiver" ||
    reason === "runtime_object_receiver" ||
    reason === "runtime_object_function_receiver" ||
    reason === "argument_receiver" ||
    reason === "function_return_receiver" ||
    reason === "destructured_variable_receiver" ||
    reason === "validated_runtime_object_receiver" ||
    reason === "runtime_object_list_item_receiver" ||
    reason === "local_object_list_item_receiver"
  );
}

function resolvePropertyReceiverObjects(
  access: PropertyAccessInput,
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  propertyValueIndex: Map<string, ExtractedPropertyValueRecord>,
  propertyAccessTextIndex: Map<string, PropertyAccessInput[]>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>,
  loopObjectBindingIndex: Map<string, ObjectFlowBinding[]>,
  flowAnalysis: LocalFlowAnalysis
): ReceiverObjectResolution {
  if (access.receiverKind === "property_access") {
    const single = resolvePropertyReceiverObject(
      access,
      coreBySymbol,
      objectMap,
      propertyValueIndex,
      propertyAccessTextIndex,
      localBindingIndex,
      destructuringBindingIndex,
      loopBindingIndex,
      objectFlowBindingIndex,
      loopObjectBindingIndex,
      flowAnalysis
    );
    return single.object ? { objects: [single.object], resolutionKind: "single" } : single;
  }
  return resolveReceiverObjects(
    access,
    coreBySymbol,
    objectMap,
    localBindingIndex,
    destructuringBindingIndex,
    loopBindingIndex,
    objectFlowBindingIndex,
    loopObjectBindingIndex,
    flowAnalysis
  );
}

function findPropertyAccessByText(
  propertyAccessTextIndex: Map<string, PropertyAccessInput[]>,
  sourceVerbId: string,
  text: string,
  before: Pick<PropertyAccessInput, "line" | "column">
): PropertyAccessInput | undefined {
  const candidates = propertyAccessTextIndex.get(`${sourceVerbId}\t${text}`) ?? [];
  return [...candidates]
    .filter((candidate) => candidate.line < before.line || (candidate.line === before.line && candidate.column <= before.column))
    .at(-1);
}

function resolveObjectValuedProperty(
  object: ObjectRef,
  property: string,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  propertyValueIndex: Map<string, ExtractedPropertyValueRecord>
): ObjectRef[] {
  const lower = property.toLowerCase();
  const objectRecord = objectMap.get(object);
  if (lower === "owner") return objectRecord?.owner ? [objectRecord.owner] : [];
  if (lower === "location") return objectRecord?.location ? [objectRecord.location] : [];
  if (lower === "contents") return objectRecord?.contents?.filter((item): item is ObjectRef => typeof item === "string") ?? [];

  const value = propertyValueIndex.get(propertyValueKey(object, property));
  if (value?.value.type === "object" && "object" in value.value && typeof value.value.object === "string") return [value.value.object];
  return [];
}

function resolveObjectListValuedProperty(
  object: ObjectRef,
  property: string,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  propertyValueIndex: Map<string, ExtractedPropertyValueRecord>
): ObjectRef[] {
  const lower = property.toLowerCase();
  const objectRecord = objectMap.get(object);
  if (lower === "contents") return objectRecord?.contents?.filter((item): item is ObjectRef => typeof item === "string") ?? [];

  const value = propertyValueIndex.get(propertyValueKey(object, property));
  if (value?.value.type !== "list" || value.value.truncated || value.value.redacted || !Array.isArray(value.value.objectRefs)) return [];
  return value.value.objectRefs.filter((item): item is ObjectRef => typeof item === "string");
}

function unsupportedPropertyReceiverReason(access: Pick<PropertyAccessInput, "receiverKind" | "receiverRaw">): UnresolvedRef["reason"] {
  if (isRuntimePropertyChainReceiver(access.receiverRaw)) return "runtime_property_chain_receiver";
  switch (access.receiverKind) {
    case "variable":
      return "variable_receiver";
    case "player":
      return "player_receiver";
    case "caller":
      return "caller_receiver";
    case "property_access":
      return "property_receiver";
    case "computed_property_access":
      return "computed_property_receiver";
    case "expression":
      return "expression_receiver";
    case "unknown":
      return "unknown_receiver";
    default:
      return "unsupported_receiver";
  }
}

function isRuntimePropertyChainReceiver(receiverRaw: string): boolean {
  return /^(player|caller|dobj|iobj)\s*\./i.test(receiverRaw.trim());
}

function detectPropertyResolutionKind(
  receiverKind: PropertyAccessInput["receiverKind"],
  inheritanceDepth: number
): PropertyCandidateEdge["resolutionKind"] {
  if (receiverKind === "this") {
    return inheritanceDepth === 0 ? "this_static_property" : "this_inherited_static_property";
  }
  return inheritanceDepth === 0 ? "static_receiver_static_property" : "inherited_static_receiver_static_property";
}

function detectVerbCallResolutionKind(receiverKind: CallsiteInput["receiverKind"], inheritanceDepth: number): VerbCallCandidateEdge["resolutionKind"] {
  if (receiverKind === "this") {
    return inheritanceDepth === 0 ? "this_static_selector" : "this_inherited_static_selector";
  }
  return inheritanceDepth === 0 ? "static_receiver_static_selector" : "inherited_static_receiver_static_selector";
}

function resolveCallReceiverObjects(
  callsite: CallsiteInput,
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>,
  loopObjectBindingIndex: Map<string, ObjectFlowBinding[]>,
  flowAnalysis?: LocalFlowAnalysis
): ReceiverObjectResolution {
  return resolveReceiverObjects(
    callsite,
    coreBySymbol,
    objectMap,
    localBindingIndex,
    destructuringBindingIndex,
    loopBindingIndex,
    objectFlowBindingIndex,
    loopObjectBindingIndex,
    flowAnalysis
  );
}

function resolveReceiverObjects(
  input: Pick<
    CallsiteInput | PropertyAccessInput,
    "receiverKind" | "receiverRaw" | "sourceObject" | "sourcePath" | "sourceVerbId" | "line" | "column" | "controlFlowPath"
  >,
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>,
  loopObjectBindingIndex: Map<string, ObjectFlowBinding[]>,
  flowAnalysis?: LocalFlowAnalysis
): ReceiverObjectResolution {
  if (input.receiverKind === "this") {
    if (objectMap.has(input.sourceObject)) return { objects: [input.sourceObject], resolutionKind: "single" };
    return { reason: "missing_object", receiverObject: input.sourceObject };
  }

  if (input.receiverKind === "literal_object") {
    if (objectMap.has(input.receiverRaw as ObjectRef)) return { objects: [input.receiverRaw as ObjectRef], resolutionKind: "single" };
    return { reason: "missing_object" };
  }

  if (input.receiverKind === "system_object") {
    const candidate = coreBySymbol.get(coreSymbolKey(input.receiverRaw));
    if (!candidate) return { reason: "no_core_candidate" };
    if (candidate.kind !== "core_candidate") return { reason: "core_collection_candidate" };
    if (!objectMap.has(candidate.target)) return { reason: "core_candidate_missing_target_object", receiverObject: candidate.target };
    return { objects: [candidate.target], resolutionKind: "single" };
  }

  if (input.receiverKind === "player") return { reason: "player_receiver" };
  if (input.receiverKind === "caller") return { reason: "caller_receiver" };

  if (input.receiverKind === "variable") {
    return resolveVariableReceiverObjects(
      input,
      coreBySymbol,
      objectMap,
      localBindingIndex,
      destructuringBindingIndex,
      loopBindingIndex,
      objectFlowBindingIndex,
      loopObjectBindingIndex,
      flowAnalysis
    );
  }

  return { reason: "unsupported_receiver" };
}

function resolveVariableReceiverObjects(
  input: Pick<CallsiteInput | PropertyAccessInput, "receiverRaw" | "sourceVerbId" | "sourceObject" | "sourcePath" | "line" | "column" | "controlFlowPath">,
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  localBindingIndex: Map<string, LocalBindingInput[]>,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>,
  objectFlowBindingIndex: Map<string, ObjectFlowBinding[]>,
  loopObjectBindingIndex: Map<string, ObjectFlowBinding[]>,
  flowAnalysis?: LocalFlowAnalysis
): ReceiverObjectResolution {
  if (flowAnalysis) {
    const state = flowAnalysis.lookupVariableState(input);
    if (state) {
      if (state.objects && state.objects.length > 0) {
        return {
          objects: state.objects,
          resolutionKind:
            state.valueKind === "object_candidate_set" || state.provenance.endsWith("_loop") ? "contents_loop" : "single"
        };
      }
      return { reason: flowReasonToUnresolvedReason(state.reason) };
    }
  }

  const bindings = (localBindingIndex.get(variableKey(input.sourceVerbId, input.receiverRaw)) ?? []).filter((binding) =>
    isBefore(binding, input)
  );
  const candidates = new Set<ObjectRef>();
  for (const binding of bindings) {
    const candidate = resolveLocalBindingObject(binding, coreBySymbol, objectMap);
    if (candidate) candidates.add(candidate);
  }

  const objectFlowBindings = (objectFlowBindingIndex.get(variableKey(input.sourceVerbId, input.receiverRaw)) ?? []).filter((binding) =>
    isBefore(binding, input)
  );
  for (const binding of objectFlowBindings) {
    for (const object of binding.objects) candidates.add(object);
  }

  const loopObjectBindings = (loopObjectBindingIndex.get(variableKey(input.sourceVerbId, input.receiverRaw)) ?? []).filter((binding) =>
    isBefore(binding, input)
  );
  if (candidates.size === 0 && loopObjectBindings.length > 0) {
    const loopCandidates = new Set<ObjectRef>();
    for (const binding of loopObjectBindings) {
      for (const object of binding.objects) loopCandidates.add(object);
    }
    if (loopCandidates.size > 0) return { objects: [...loopCandidates], resolutionKind: "contents_loop" };
  }

  if (candidates.size === 0) {
    return { reason: classifyUnresolvedVariableReceiver(input, destructuringBindingIndex, loopBindingIndex) };
  }
  if (candidates.size > 1) return { reason: "ambiguous_variable_receiver" };
  return { objects: [[...candidates][0]!], resolutionKind: "single" };
}

function noMatchingVerbReason(resolutionKind: "single" | "contents_loop"): UnresolvedRef["reason"] {
  return resolutionKind === "contents_loop" ? "no_matching_content_item_candidate" : "no_matching_direct_or_inherited_verb";
}

function noMatchingPropertyReason(resolutionKind: "single" | "contents_loop"): UnresolvedRef["reason"] {
  return resolutionKind === "contents_loop" ? "no_matching_content_item_candidate" : "no_matching_property";
}

const GENERIC_FEATURE_OBJECT: ObjectRef = "#74";

async function optionalFeatureHookMetadata(
  callsite: CallsiteInput,
  candidateObjects: ObjectRef[],
  objectMap: Map<ObjectRef, ExtractedObjectRecord>,
  flowAnalysis: LocalFlowAnalysis,
  sourceLines: SourceLineCache
): Promise<Pick<UnresolvedRef, "candidateObjects" | "compositionKind" | "optionalHookHandled"> | undefined> {
  if (callsite.receiverKind !== "variable" || !callsite.selector) return undefined;
  if (candidateObjects.length === 0) return undefined;
  const state = flowAnalysis.lookupVariableState(callsite);
  if (state?.provenance !== "object_list_property_loop") return undefined;
  if (!isFeatureCollectionText(state.sourceText)) return undefined;
  if (!candidateObjects.every((object) => isObjectOrDescendantOf(object, GENERIC_FEATURE_OBJECT, objectMap))) return undefined;
  if (!(await isTryExceptOptionalHookCall(sourceLines, callsite))) return undefined;
  return {
    candidateObjects,
    compositionKind: "feature_list_hook",
    optionalHookHandled: true
  };
}

function isFeatureCollectionText(sourceText: string | undefined): boolean {
  if (!sourceText) return false;
  return /^\(?\s*(?:this|[A-Za-z_][A-Za-z0-9_]*)\.features\s*\)?$/i.test(sourceText.trim());
}

async function isTryExceptOptionalHookCall(sourceLines: SourceLineCache, callsite: CallsiteInput): Promise<boolean> {
  const lines = await sourceLines.getLines(callsite.sourcePath);
  if (lines.length === 0) return false;

  let tryLine = -1;
  for (let index = callsite.line - 1; index >= 0 && index >= callsite.line - 8; index -= 1) {
    const text = lines[index]?.trim().toLowerCase() ?? "";
    if (text.startsWith("endtry")) break;
    if (text === "try") {
      tryLine = index;
      break;
    }
  }
  if (tryLine < 0) return false;

  for (let index = callsite.line + 1; index < lines.length && index <= callsite.line + 12; index += 1) {
    const text = lines[index]?.trim().toLowerCase() ?? "";
    if (text.startsWith("endtry")) return false;
    if (/^except\b/.test(text) && /\b(any|e_verbnf)\b/.test(text)) return true;
  }
  return false;
}

function isKnownRuntimeObjectFunctionReceiver(receiverRaw: string): boolean {
  return /^caller_perms\s*\(\s*\)$/i.test(receiverRaw.trim());
}

function isHasPropertyGuard(
  guard: BranchGuardInput
): guard is BranchGuardInput & { guardKind: "has_property"; receiverKind: PropertyAccessInput["receiverKind"]; receiverRaw: string; property: string } {
  return guard.guardKind === "has_property" && !!guard.receiverKind && !!guard.receiverRaw && !!guard.property;
}

function isIsaPropertyGuard(
  guard: BranchGuardInput
): guard is BranchGuardInput & { guardKind: "isa"; receiverKind: "property_access"; receiverRaw: string } {
  return guard.guardKind === "isa" && guard.receiverKind === "property_access" && !!guard.receiverRaw;
}

function isHasVerbGuard(
  guard: BranchGuardInput
): guard is BranchGuardInput & {
  guardKind: "has_callable_verb" | "has_verb";
  receiverKind: CallsiteInput["receiverKind"];
  receiverRaw: string;
  verb: string;
} {
  return (guard.guardKind === "has_callable_verb" || guard.guardKind === "has_verb") && !!guard.receiverKind && !!guard.receiverRaw && !!guard.verb;
}

function isValidGuard(guard: BranchGuardInput): guard is BranchGuardInput & { guardKind: "valid"; variable: string } {
  return guard.guardKind === "valid" && !!guard.variable;
}

function validGuardAppliesToPropertyAccess(
  guards: Array<BranchGuardInput & { guardKind: "valid"; variable: string }>,
  access: PropertyAccessInput
): boolean {
  if (access.receiverKind !== "variable") return false;
  const guard = guards.find((candidate) => validGuardApplies(candidate, access));
  return !!guard;
}

function validGuardApplies(
  guard: BranchGuardInput & { guardKind: "valid"; variable: string },
  access: PropertyAccessInput
): boolean {
  if (guard.sourceVerbId !== access.sourceVerbId) return false;
  if (guard.variable.toLowerCase() !== access.receiverRaw.toLowerCase()) return false;

  if (guard.guardScope === "conditional_expression") {
    return guard.guardedLine === access.line && guard.guardedColumn === access.column;
  }

  if (guard.guardScope === "branch") {
    return isWithinGuardedBranch(guard.controlFlowPath, access.controlFlowPath);
  }

  if (guard.guardScope === "sibling_continuation" || guard.guardScope === "post_continuation") {
    return isBefore(guard, access) && sameControlFlowPath(guard.controlFlowPath, access.controlFlowPath);
  }

  return false;
}

function guardedPropertyAccessEdge(
  access: PropertyAccessInput,
  guards: Array<BranchGuardInput & { guardKind: "has_property"; receiverKind: PropertyAccessInput["receiverKind"]; receiverRaw: string; property: string }>,
  sourceVerbNames: Map<string, string>,
  receiverObject?: ObjectRef
): GuardedPropertyAccessEdge | undefined {
  if (access.propertyKind !== "static" || !access.property) return undefined;
  const guard = guards.find((candidate) => hasPropertyGuardApplies(candidate, access));
  if (!guard) return undefined;
  return {
    kind: "guarded_property_access_edge",
    sourceVerbId: access.sourceVerbId,
    sourceVerbName: sourceVerbNameFor(sourceVerbNames, access.sourceVerbId),
    sourceObject: access.sourceObject,
    sourcePath: access.sourcePath,
    line: access.line,
    column: access.column,
    accessKind: access.accessKind,
    receiverKind: access.receiverKind,
    receiverRaw: access.receiverRaw,
    ...(receiverObject ? { receiverObject } : {}),
    property: access.property,
    ref: `${access.receiverRaw}.${access.property}`,
    guardText: guard.guardText,
    guardScope: guard.guardScope,
    resolutionKind: "has_property_guarded_property",
    confidence: "guarded"
  };
}

function isaGuardedPropertyAccessEdge(
  access: PropertyAccessInput,
  guards: Array<BranchGuardInput & { guardKind: "isa"; receiverKind: "property_access"; receiverRaw: string }>,
  sourceVerbNames: Map<string, string>,
  receiverObject?: ObjectRef
): GuardedPropertyAccessEdge | undefined {
  if (access.propertyKind !== "static" || !access.property) return undefined;
  const guard = guards.find((candidate) => isaPropertyGuardApplies(candidate, access));
  if (!guard) return undefined;
  return {
    kind: "guarded_property_access_edge",
    sourceVerbId: access.sourceVerbId,
    sourceVerbName: sourceVerbNameFor(sourceVerbNames, access.sourceVerbId),
    sourceObject: access.sourceObject,
    sourcePath: access.sourcePath,
    line: access.line,
    column: access.column,
    accessKind: access.accessKind,
    receiverKind: access.receiverKind,
    receiverRaw: access.receiverRaw,
    ...(receiverObject ? { receiverObject } : {}),
    property: access.property,
    ref: `${access.receiverRaw}.${access.property}`,
    guardText: guard.guardText,
    guardScope: guard.guardScope,
    resolutionKind: "isa_guarded_property",
    confidence: "guarded"
  };
}

function guardedVerbCallEdge(
  callsite: CallsiteInput,
  guards: Array<BranchGuardInput & { guardKind: "has_callable_verb" | "has_verb"; receiverKind: CallsiteInput["receiverKind"]; receiverRaw: string; verb: string }>,
  sourceVerbNames: Map<string, string>,
  receiverObject?: ObjectRef
): GuardedVerbCallEdge | undefined {
  if (callsite.selectorKind !== "static" || !callsite.selector) return undefined;
  const guard = guards.find((candidate) => hasVerbGuardApplies(candidate, callsite));
  if (!guard) return undefined;
  return {
    kind: "guarded_verb_call_edge",
    sourceVerbId: callsite.sourceVerbId,
    sourceVerbName: sourceVerbNameFor(sourceVerbNames, callsite.sourceVerbId),
    sourceObject: callsite.sourceObject,
    sourcePath: callsite.sourcePath,
    line: callsite.line,
    column: callsite.column,
    receiverKind: callsite.receiverKind,
    receiverRaw: callsite.receiverRaw,
    ...(receiverObject ? { receiverObject } : {}),
    selector: callsite.selector,
    ref: `${callsite.receiverRaw}:${callsite.selector}`,
    guardText: guard.guardText,
    guardScope: guard.guardScope,
    resolutionKind: guard.guardKind === "has_callable_verb" ? "has_callable_verb_guarded_call" : "has_verb_guarded_call",
    confidence: "guarded"
  };
}

function hasPropertyGuardApplies(
  guard: BranchGuardInput & { guardKind: "has_property"; receiverKind: PropertyAccessInput["receiverKind"]; receiverRaw: string; property: string },
  access: PropertyAccessInput
): boolean {
  if (guard.sourceVerbId !== access.sourceVerbId) return false;
  if (guard.property.toLowerCase() !== (access.property ?? "").toLowerCase()) return false;
  if (guard.receiverKind !== access.receiverKind || guard.receiverRaw.toLowerCase() !== access.receiverRaw.toLowerCase()) return false;

  if (guard.guardScope === "conditional_expression") {
    return guard.guardedLine === access.line && guard.guardedColumn === access.column;
  }

  if (guard.guardScope === "branch") {
    return isWithinGuardedBranch(guard.controlFlowPath, access.controlFlowPath);
  }

  if (guard.guardScope === "sibling_continuation" || guard.guardScope === "post_continuation") {
    return isBefore(guard, access) && sameControlFlowPath(guard.controlFlowPath, access.controlFlowPath);
  }

  return false;
}

function isaPropertyGuardApplies(
  guard: BranchGuardInput & { guardKind: "isa"; receiverKind: "property_access"; receiverRaw: string },
  access: PropertyAccessInput
): boolean {
  if (guard.sourceVerbId !== access.sourceVerbId) return false;
  if (access.propertyKind !== "static" || !access.property) return false;
  if (guard.receiverRaw.toLowerCase() !== `${access.receiverRaw}.${access.property}`.toLowerCase()) return false;

  if (guard.guardScope === "conditional_expression") {
    return guard.guardedLine === access.line && guard.guardedColumn === access.column;
  }

  if (guard.guardScope === "branch") {
    return isWithinGuardedBranch(guard.controlFlowPath, access.controlFlowPath);
  }

  if (guard.guardScope === "sibling_continuation" || guard.guardScope === "post_continuation") {
    return isBefore(guard, access) && sameControlFlowPath(guard.controlFlowPath, access.controlFlowPath);
  }

  return false;
}

function hasVerbGuardApplies(
  guard: BranchGuardInput & { guardKind: "has_callable_verb" | "has_verb"; receiverKind: CallsiteInput["receiverKind"]; receiverRaw: string; verb: string },
  callsite: CallsiteInput
): boolean {
  if (guard.sourceVerbId !== callsite.sourceVerbId) return false;
  if (guard.verb.toLowerCase() !== (callsite.selector ?? "").toLowerCase()) return false;
  if (guard.receiverKind !== callsite.receiverKind || guard.receiverRaw.toLowerCase() !== callsite.receiverRaw.toLowerCase()) return false;

  if (guard.guardScope === "conditional_expression") {
    return guard.guardedLine === callsite.line && guard.guardedColumn === callsite.column;
  }

  if (guard.guardScope === "branch") {
    return isWithinGuardedBranch(guard.controlFlowPath, callsite.controlFlowPath);
  }

  if (guard.guardScope === "sibling_continuation" || guard.guardScope === "post_continuation") {
    return isBefore(guard, callsite) && sameControlFlowPath(guard.controlFlowPath, callsite.controlFlowPath);
  }

  return false;
}

function sameControlFlowPath(left: string[] | undefined, right: string[] | undefined): boolean {
  const leftPath = left ?? [];
  const rightPath = right ?? [];
  return leftPath.length === rightPath.length && leftPath.every((part, index) => part === rightPath[index]);
}

function isWithinGuardedBranch(guardPath: string[] | undefined, usePath: string[] | undefined): boolean {
  const leftPath = guardPath ?? [];
  const rightPath = usePath ?? [];
  if (rightPath.length < leftPath.length) return false;
  if (!leftPath.every((part, index) => part === rightPath[index])) return false;
  const nextSegment = rightPath[leftPath.length];
  return !nextSegment?.startsWith("else_clause@") && !nextSegment?.startsWith("elseif_clause@");
}

function classifyUnresolvedVariableReceiver(
  input: Pick<CallsiteInput | PropertyAccessInput, "receiverRaw" | "sourceVerbId" | "line" | "column">,
  destructuringBindingIndex: Map<string, DestructuringBindingInput[]>,
  loopBindingIndex: Map<string, LoopBindingInput[]>
): UnresolvedRef["reason"] {
  const key = variableKey(input.sourceVerbId, input.receiverRaw);
  const priorLoops = (loopBindingIndex.get(key) ?? []).filter((binding) => isBefore(binding, input));
  if (priorLoops.some((binding) => binding.collectionKind === "contents_property")) return "local_object_list_item_receiver";

  const priorDestructuring = (destructuringBindingIndex.get(key) ?? []).filter((binding) => isBefore(binding, input));
  if (priorDestructuring.length > 0) return "destructured_variable_receiver";

  if (priorLoops.length > 0) return "variable_receiver";
  if (RUNTIME_OBJECT_VARIABLES.has(input.receiverRaw.toLowerCase())) return "runtime_object_receiver";
  return "unbound_variable_receiver";
}

const RUNTIME_OBJECT_VARIABLES = new Set(["dobj", "iobj"]);

function flowReasonToUnresolvedReason(reason: LocalVariableStateFact["reason"] | undefined): UnresolvedRef["reason"] {
  return reason ?? "unknown_flow_receiver";
}

function resolveLocalBindingObject(
  binding: LocalBindingInput,
  coreBySymbol: Map<string, CoreCandidateRecord>,
  objectMap: Map<ObjectRef, ExtractedObjectRecord>
): ObjectRef | undefined {
  if (binding.bindingKind === "this") {
    return objectMap.has(binding.sourceObject) ? binding.sourceObject : undefined;
  }
  if (binding.bindingKind === "literal_object" && binding.object && objectMap.has(binding.object as ObjectRef)) {
    return binding.object as ObjectRef;
  }
  if (binding.bindingKind === "system_object" && binding.symbol) {
    const candidate = coreBySymbol.get(coreSymbolKey(binding.symbol));
    if (candidate?.kind === "core_candidate" && objectMap.has(candidate.target)) return candidate.target;
  }
  return undefined;
}

function isBefore(left: Pick<LocalBindingInput, "line" | "column">, right: Pick<CallsiteInput | PropertyAccessInput | BranchGuardInput, "line" | "column">): boolean {
  return left.line < right.line || (left.line === right.line && left.column < right.column);
}

function unresolvedVerbCall(
  callsite: CallsiteInput,
  reason: UnresolvedRef["reason"],
  sourceVerbNames: Map<string, string>,
  receiverObject?: ObjectRef,
  metadata?: Pick<UnresolvedRef, "candidateObjects" | "compositionKind" | "optionalHookHandled">
): UnresolvedRef {
  return {
    kind: "unresolved_ref",
    sourceVerbId: callsite.sourceVerbId,
    sourceObject: callsite.sourceObject,
    sourcePath: callsite.sourcePath,
    line: callsite.line,
    column: callsite.column,
    sourceVerbName: sourceVerbNameFor(sourceVerbNames, callsite.sourceVerbId),
    refKind: "verb_call",
    ref: `${callsite.receiverRaw}:${callsite.selector ?? callsite.selectorExpression ?? ""}`,
    reason,
    receiverRaw: callsite.receiverRaw,
    ...(receiverObject ? { receiverObject } : {}),
    ...(metadata?.candidateObjects ? { candidateObjects: metadata.candidateObjects } : {}),
    ...(metadata?.compositionKind ? { compositionKind: metadata.compositionKind } : {}),
    ...(metadata?.optionalHookHandled !== undefined ? { optionalHookHandled: metadata.optionalHookHandled } : {}),
    ...(callsite.selector ? { selector: callsite.selector } : {}),
    ...(callsite.selectorExpression ? { selectorExpression: callsite.selectorExpression } : {}),
    ...(callsite.inlineErrorHandled !== undefined ? { inlineErrorHandled: callsite.inlineErrorHandled } : {}),
    ...(callsite.inlineErrorCodes ? { inlineErrorCodes: callsite.inlineErrorCodes } : {}),
    ...(callsite.inlineErrorFallbackText ? { inlineErrorFallbackText: callsite.inlineErrorFallbackText } : {}),
    ...(callsite.inlineErrorExpressionText ? { inlineErrorExpressionText: callsite.inlineErrorExpressionText } : {})
  };
}

function unresolvedSystemObject(
  ref: SystemObjectRefInput,
  reason: "no_core_candidate" | "core_collection_candidate" | "core_candidate_missing_target_object",
  sourceVerbNames: Map<string, string>,
  receiverObject?: ObjectRef
): UnresolvedRef {
  return {
    kind: "unresolved_ref",
    sourceVerbId: ref.sourceVerbId,
    sourceObject: ref.sourceObject,
    sourcePath: ref.sourcePath,
    line: ref.line,
    column: ref.column,
    sourceVerbName: sourceVerbNameFor(sourceVerbNames, ref.sourceVerbId),
    refKind: "system_object",
    ref: ref.symbol,
    reason,
    ...(receiverObject ? { receiverObject } : {}),
    context: ref.context
  };
}

async function buildUnresolvedVerbCallFindings(
  unresolvedRefs: UnresolvedRef[],
  sourceLines: SourceLineCache
): Promise<UnresolvedVerbCallFinding[]> {
  const findings: UnresolvedVerbCallFinding[] = [];
  for (const ref of unresolvedRefs) {
    if (ref.refKind !== "verb_call") continue;
    const sourceLine = await sourceLines.getLine(ref.sourcePath, ref.line);
    findings.push({
      kind: "unresolved_verb_call",
      severity: "warning",
      sourceVerbId: ref.sourceVerbId,
      sourceVerbName: ref.sourceVerbName,
      sourceObject: ref.sourceObject,
      sourcePath: ref.sourcePath,
      line: ref.line,
      column: ref.column,
      ...(sourceLine !== undefined ? { sourceLine } : {}),
      ref: ref.ref,
      reason: ref.reason,
      ...(ref.receiverRaw ? { receiverRaw: ref.receiverRaw } : {}),
      ...(ref.receiverObject ? { receiverObject: ref.receiverObject } : {}),
      ...(ref.candidateObjects ? { candidateObjects: ref.candidateObjects } : {}),
      ...(ref.compositionKind ? { compositionKind: ref.compositionKind } : {}),
      ...(ref.optionalHookHandled !== undefined ? { optionalHookHandled: ref.optionalHookHandled } : {}),
      ...(ref.selector ? { selector: ref.selector } : {}),
      ...(ref.selectorExpression ? { selectorExpression: ref.selectorExpression } : {}),
      ...(ref.inlineErrorHandled !== undefined ? { inlineErrorHandled: ref.inlineErrorHandled } : {}),
      ...(ref.inlineErrorCodes ? { inlineErrorCodes: ref.inlineErrorCodes } : {}),
      ...(ref.inlineErrorFallbackText ? { inlineErrorFallbackText: ref.inlineErrorFallbackText } : {}),
      ...(ref.inlineErrorExpressionText ? { inlineErrorExpressionText: ref.inlineErrorExpressionText } : {})
    });
  }
  return findings;
}

async function unresolvedPropertyAccess(
  access: PropertyAccessInput,
  reason: UnresolvedRef["reason"],
  sourceVerbNames: Map<string, string>,
  sourceLines: SourceLineCache,
  receiverObject?: ObjectRef,
  dynamicPropertyMetadata?: { possibleProperties?: string[]; missingProperties?: string[] }
): Promise<UnresolvedPropertyAccessFinding> {
  const sourceLine = await sourceLines.getLine(access.sourcePath, access.line);
  const propertyText = access.property ?? access.propertyExpression ?? "";
  return {
    kind: "unresolved_property_access",
    severity: "warning",
    sourceVerbId: access.sourceVerbId,
    sourceVerbName: sourceVerbNameFor(sourceVerbNames, access.sourceVerbId),
    sourceObject: access.sourceObject,
    sourcePath: access.sourcePath,
    line: access.line,
    column: access.column,
    ...(sourceLine !== undefined ? { sourceLine } : {}),
    ref: access.property ? `${access.receiverRaw}.${access.property}` : `${access.receiverRaw}.(${propertyText})`,
    reason,
    accessKind: access.accessKind,
    receiverKind: access.receiverKind,
    receiverRaw: access.receiverRaw,
    ...(receiverObject ? { receiverObject } : {}),
    ...(access.property ? { property: access.property } : {}),
    ...(access.propertyExpression ? { propertyExpression: access.propertyExpression } : {}),
    ...(dynamicPropertyMetadata?.possibleProperties ? { possibleProperties: dynamicPropertyMetadata.possibleProperties } : {}),
    ...(dynamicPropertyMetadata?.missingProperties ? { missingProperties: dynamicPropertyMetadata.missingProperties } : {}),
    ...(access.inlineErrorHandled !== undefined ? { inlineErrorHandled: access.inlineErrorHandled } : {}),
    ...(access.inlineErrorCodes ? { inlineErrorCodes: access.inlineErrorCodes } : {}),
    ...(access.inlineErrorFallbackText ? { inlineErrorFallbackText: access.inlineErrorFallbackText } : {}),
    ...(access.inlineErrorExpressionText ? { inlineErrorExpressionText: access.inlineErrorExpressionText } : {})
  };
}

class SourceLineCache {
  private readonly files = new Map<string, Promise<string[]>>();

  constructor(private readonly extractDir: string) {}

  async getLine(sourcePath: string, line: number): Promise<string | undefined> {
    const lines = await this.getLines(sourcePath);
    return lines[line];
  }

  async getLines(sourcePath: string): Promise<string[]> {
    let pending = this.files.get(sourcePath);
    if (!pending) {
      pending = readFile(join(this.extractDir, sourcePath), "utf8")
        .then((source) => source.split(/\r?\n/))
        .catch(() => []);
      this.files.set(sourcePath, pending);
    }
    return pending;
  }
}

async function writeEdges(outputDir: string, pretty: boolean, edges: ResolvedEdges): Promise<void> {
  const edgesDir = join(outputDir, "edges");
  const findingsDir = join(outputDir, "findings");
  const flowDir = join(outputDir, "flow");
  const systemObjectWriter = new JsonlWriter<SystemObjectEdge>(join(edgesDir, "system_object_edges.jsonl"), pretty);
  const rootPropertyWriter = new JsonlWriter<RootPropertyEdge>(join(edgesDir, "root_property_edges.jsonl"), pretty);
  const rootVerbCallWriter = new JsonlWriter<RootVerbCallEdge>(join(edgesDir, "root_verb_call_edges.jsonl"), pretty);
  const literalObjectWriter = new JsonlWriter<LiteralObjectEdge>(join(edgesDir, "literal_object_edges.jsonl"), pretty);
  const verbCallCandidateWriter = new JsonlWriter<VerbCallCandidateEdge>(join(edgesDir, "verb_call_candidate_edges.jsonl"), pretty);
  const propertyCandidateWriter = new JsonlWriter<PropertyCandidateEdge>(join(edgesDir, "property_candidate_edges.jsonl"), pretty);
  const guardedPropertyAccessWriter = new JsonlWriter<GuardedPropertyAccessEdge>(join(edgesDir, "guarded_property_access_edges.jsonl"), pretty);
  const guardedVerbCallWriter = new JsonlWriter<GuardedVerbCallEdge>(join(edgesDir, "guarded_verb_call_edges.jsonl"), pretty);
  const unresolvedWriter = new JsonlWriter<UnresolvedRef>(join(edgesDir, "unresolved_refs.jsonl"), pretty);
  const localVariableStateWriter = new JsonlWriter<LocalVariableStateFact>(join(flowDir, "local_variable_states.jsonl"), pretty);
  const inferredReceiverCandidateWriter = new JsonlWriter<InferredReceiverCandidateFact>(join(flowDir, "inferred_receiver_candidates.jsonl"), pretty);
  const unresolvedVerbCallWriter = new JsonlWriter<UnresolvedVerbCallFinding>(join(findingsDir, "unresolved_verb_calls.jsonl"), pretty);
  const unresolvedPropertyAccessWriter = new JsonlWriter<UnresolvedPropertyAccessFinding>(
    join(findingsDir, "unresolved_property_accesses.jsonl"),
    pretty
  );
  try {
    for (const edge of edges.systemObjectEdges) await systemObjectWriter.write(edge);
    for (const edge of edges.rootPropertyEdges) await rootPropertyWriter.write(edge);
    for (const edge of edges.rootVerbCallEdges) await rootVerbCallWriter.write(edge);
    for (const edge of edges.literalObjectEdges) await literalObjectWriter.write(edge);
    for (const edge of edges.verbCallCandidateEdges) await verbCallCandidateWriter.write(edge);
    for (const edge of edges.propertyCandidateEdges) await propertyCandidateWriter.write(edge);
    for (const edge of edges.guardedPropertyAccessEdges) await guardedPropertyAccessWriter.write(edge);
    for (const edge of edges.guardedVerbCallEdges) await guardedVerbCallWriter.write(edge);
    for (const edge of edges.unresolvedRefs) await unresolvedWriter.write(edge);
    for (const state of edges.localVariableStates) await localVariableStateWriter.write(state);
    for (const candidate of edges.inferredReceiverCandidates) await inferredReceiverCandidateWriter.write(candidate);
    for (const finding of edges.unresolvedVerbCallFindings) await unresolvedVerbCallWriter.write(finding);
    for (const finding of edges.unresolvedPropertyAccessFindings) await unresolvedPropertyAccessWriter.write(finding);
  } finally {
    await Promise.all([
      systemObjectWriter.close(),
      rootPropertyWriter.close(),
      rootVerbCallWriter.close(),
      literalObjectWriter.close(),
      verbCallCandidateWriter.close(),
      propertyCandidateWriter.close(),
      guardedPropertyAccessWriter.close(),
      guardedVerbCallWriter.close(),
      unresolvedWriter.close(),
      localVariableStateWriter.close(),
      inferredReceiverCandidateWriter.close(),
      unresolvedVerbCallWriter.close(),
      unresolvedPropertyAccessWriter.close()
    ]);
  }
}
