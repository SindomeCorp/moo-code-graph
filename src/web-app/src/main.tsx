import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import cytoscape, { type Core, type Css, type EventObject, type LayoutOptions } from "cytoscape";
import cola from "cytoscape-cola";
import coseBilkent from "cytoscape-cose-bilkent";
import dagre from "cytoscape-dagre";
import euler from "cytoscape-euler";
import fcose from "cytoscape-fcose";
import klay from "cytoscape-klay";
import "./styles.css";

cytoscape.use(cola);
cytoscape.use(coseBilkent);
cytoscape.use(dagre);
cytoscape.use(euler);
cytoscape.use(fcose);
cytoscape.use(klay);

type WorkspaceKey = "code_bugs" | "handled_expected" | "dead_code" | "graph_refinement" | "code_insights" | "mutation_invariants";
type MainView = "report" | "graph";
type GraphMode = "scoped" | "overview" | "source";
type GraphLayoutMode = "wide" | "classic" | "layered" | "force" | "coseBilkent" | "cola" | "euler" | "klay" | "concentric";
type GraphLabelMode = "auto" | "compact" | "full";
type GraphExpandMode = "all" | "callers" | "callees" | "properties" | "objectMembers";

interface Catalog {
  latest?: { dbName: string; runId: string };
  databases: Array<{ dbName: string; latestRunId?: string; runs: Array<{ runId: string; generatedAt: string; parseErrorCount: number }> }>;
}

interface CatalogRun {
  runId: string;
  generatedAt: string;
  parseErrorCount: number;
}

interface Summary {
  dbName: string;
  runId: string;
  generatedAt: string;
  total: number;
  parseErrorCount: number;
  parseErrors: Array<{ sourceVerbId: string; sourcePath: string; line: number; column: number; message: string; sourceLine?: string }>;
  workspaces: Array<{ workspace: WorkspaceKey; label: string; count: number; buckets: Array<{ bucket: string; count: number; reasons: Array<{ reason: string; count: number }> }> }>;
}

interface ItemsPage {
  total: number;
  offset: number;
  limit: number;
  buckets: Array<{ bucket: string; count: number }>;
  reasons: Array<{ reason: string; count: number }>;
  items: ReportItem[];
}

interface ReportItem {
  workspace: WorkspaceKey;
  domain: string;
  bucket: string;
  reason: string;
  ref: string;
  refKind: string;
  description: string;
  sourceVerbId: string;
  sourceVerbName?: string;
  sourceObject: string;
  sourcePath: string;
  line: number;
  column: number;
  issue: {
    sourceSnippet?: {
      lines: Array<{ line: number; text: string; highlight: boolean }>;
    };
    permissions?: string[];
    argumentSpecs?: string[];
    callerCount?: number;
    guardText?: string;
    inlineErrorCodes?: string[];
    receiverObject?: string;
    cyclomaticComplexity?: number;
    nonBlankLineCount?: number;
    maxControlFlowDepth?: number;
    statementCount?: number;
    variableName?: string;
    bindingKind?: string;
    count?: number;
    distinctCount?: number;
    detail?: string;
    relatedSourceVerbId?: string;
    relatedSourceVerbName?: string;
    relatedSourceObject?: string;
    dbShape?: string;
    rhsShape?: string;
    rightText?: string;
    effectiveValueObject?: string;
    effectiveValueSource?: string;
    effectiveValuePreview?: string;
  };
}

interface ReportJob {
  id: string;
  dbName: string;
  status: "running" | "complete" | "failed";
  phase: string;
  message?: string;
  result?: { dbName: string; runId: string; runDir: string; reportDir: string };
  error?: string;
}

interface GraphNode {
  id: string;
  kind: string;
  label: string;
  object?: string;
  verbId?: string;
  counts?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  label?: string;
  confidence?: string;
  count?: number;
  sourceLocation?: {
    sourceVerbId: string;
    sourceVerbName?: string;
    sourceObject: string;
    sourcePath: string;
    line: number;
    column: number;
  };
  metadata?: Record<string, unknown>;
}

interface GraphPayload {
  mode: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  limit: number;
  total: { nodes: number; edges: number };
  seed?: string;
}

interface GraphSearchResult {
  id: string;
  kind: "verb" | "object" | "core" | "issue";
  label: string;
  detail?: string;
}

interface GraphBreadcrumb {
  id: string;
  label: string;
}

interface GraphPathState {
  startId?: string;
  endId?: string;
  ids: Set<string>;
  message?: string;
}

const workspaceOrder: WorkspaceKey[] = ["code_bugs", "code_insights", "mutation_invariants", "dead_code", "handled_expected", "graph_refinement"];
const GRAPH_LIMIT = 1500;
const MIN_GRAPH_ZOOM = 0.08;
const MAX_GRAPH_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 1.85;
const EDGE_KIND_OPTIONS = ["call", "property", "guarded", "unresolved", "inheritance", "core", "contains", "summary"] as const;
const DEFAULT_VISIBLE_EDGE_KINDS = new Set<string>(["call", "property", "guarded", "unresolved", "inheritance", "core", "summary"]);

function App() {
  const [catalog, setCatalog] = useState<Catalog | undefined>();
  const [summary, setSummary] = useState<Summary | undefined>();
  const [itemsPage, setItemsPage] = useState<ItemsPage | undefined>();
  const [dbName, setDbName] = useState("");
  const [runId, setRunId] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceKey>("code_bugs");
  const [bucket, setBucket] = useState("");
  const [reason, setReason] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [job, setJob] = useState<ReportJob | undefined>();
  const [mainView, setMainView] = useState<MainView>("report");

  useEffect(() => {
    loadJson<Catalog>("/api/catalog")
      .then((next) => {
        setCatalog(next);
        const initialDb = next.latest?.dbName ?? next.databases[0]?.dbName ?? "";
        const initialRun = next.latest?.runId ?? next.databases.find((db) => db.dbName === initialDb)?.latestRunId ?? "";
        setDbName(initialDb);
        setRunId(initialRun);
      })
      .catch((cause) => setError(errorMessage(cause)));
  }, []);

  useEffect(() => {
    if (!dbName || !runId) return;
    setSummary(undefined);
    setItemsPage(undefined);
    loadJson<Summary>(`/api/reports/${encodeURIComponent(dbName)}/${encodeURIComponent(runId)}/summary`)
      .then((next) => {
        setSummary(next);
        const firstNonEmpty = workspaceOrder.find((key) => next.workspaces.find((entry) => entry.workspace === key)?.count);
        setWorkspace(firstNonEmpty ?? "code_bugs");
      })
      .catch((cause) => setError(errorMessage(cause)));
  }, [dbName, runId]);

  useEffect(() => {
    if (!dbName || !runId) return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        workspace,
        offset: String(offset),
        limit: "50"
      });
      if (bucket) params.set("bucket", bucket);
      if (reason) params.set("reason", reason);
      if (search.trim()) params.set("q", search.trim());
      loadJson<ItemsPage>(`/api/reports/${encodeURIComponent(dbName)}/${encodeURIComponent(runId)}/items?${params.toString()}`)
        .then(setItemsPage)
        .catch((cause) => setError(errorMessage(cause)));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [dbName, runId, workspace, bucket, reason, search, offset]);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    const timer = window.setInterval(() => {
      loadJson<ReportJob>(`/api/jobs/${encodeURIComponent(job.id)}`)
        .then((next) => {
          setJob(next);
          if (next.status === "complete") {
            refreshCatalog(next.result?.dbName, next.result?.runId);
          }
          if (next.status === "failed") setError(next.error ?? "Report generation failed");
        })
        .catch((cause) => setError(errorMessage(cause)));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [job]);

  const selectedDb = catalog?.databases.find((db) => db.dbName === dbName);
  const selectedWorkspace = summary?.workspaces.find((entry) => entry.workspace === workspace);
  const bucketOptions = selectedWorkspace?.buckets ?? [];
  const reasonOptions = itemsPage?.reasons ?? selectedWorkspace?.buckets.flatMap((entry) => entry.reasons) ?? [];
  const pageEnd = Math.min((itemsPage?.offset ?? 0) + (itemsPage?.items.length ?? 0), itemsPage?.total ?? 0);

  function switchWorkspace(next: WorkspaceKey) {
    setWorkspace(next);
    setBucket("");
    setReason("");
    setOffset(0);
  }

  function switchBucket(next: string) {
    setBucket(next);
    setReason("");
    setOffset(0);
  }

  function refreshCatalog(nextDbName?: string, nextRunId?: string) {
    loadJson<Catalog>("/api/catalog")
      .then((next) => {
        setCatalog(next);
        const latestDb = nextDbName ?? next.latest?.dbName ?? dbName;
        const latestRun = nextRunId ?? next.latest?.runId ?? next.databases.find((db) => db.dbName === latestDb)?.latestRunId ?? "";
        setDbName(latestDb);
        setRunId(latestRun);
      })
      .catch((cause) => setError(errorMessage(cause)));
  }

  function regenerateFromLatestExtract() {
    if (!dbName || job?.status === "running") return;
    setError("");
    postReportJob(`/api/reports/${encodeURIComponent(dbName)}/regenerate-from-latest-extract`)
      .then(setJob)
      .catch((cause) => setError(errorMessage(cause)));
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>MOO Code Graph Reports</h1>
          <p>{summary ? `${summary.dbName} / ${summary.runId}` : "Select a report run"}</p>
        </div>
        <div className="report-controls">
          <div className="selectors">
            <label>
              <span>Database</span>
              <select value={dbName} onChange={(event) => { setDbName(event.target.value); setRunId(catalog?.databases.find((db) => db.dbName === event.target.value)?.latestRunId ?? ""); }}>
                {catalog?.databases.map((db) => <option key={db.dbName} value={db.dbName}>{db.dbName}</option>)}
              </select>
            </label>
            <label>
              <span>Report</span>
              <select value={runId} onChange={(event) => setRunId(event.target.value)}>
                {selectedDb?.runs.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {reportOptionLabel(run, run.runId === selectedDb.latestRunId)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button className="primary-action" disabled={!dbName || job?.status === "running"} onClick={regenerateFromLatestExtract}>
            {job?.status === "running" ? "Generating..." : "Generate From Latest Extract"}
          </button>
        </div>
      </header>

      {error ? <div className="notice error">{error}</div> : null}
      {job ? (
        <div className={`notice ${job.status === "failed" ? "error" : ""}`}>
          {job.status === "running" ? `Generating ${job.dbName}: ${job.phase}${job.message ? ` (${job.message})` : ""}` : null}
          {job.status === "complete" ? `Generated ${job.result?.dbName ?? job.dbName} / ${job.result?.runId ?? ""}` : null}
          {job.status === "failed" ? job.error ?? "Report generation failed" : null}
        </div>
      ) : null}
      {summary?.parseErrorCount ? (
        <section className="notice blocker">
          <strong>{summary.parseErrorCount} parse errors found</strong>
          {summary.parseErrors.slice(0, 5).map((parseError) => (
            <div key={`${parseError.sourceVerbId}-${parseError.line}-${parseError.column}`}>
              {parseError.sourceVerbId} {parseError.sourcePath}:{parseError.line}:{parseError.column} {parseError.message}
            </div>
          ))}
        </section>
      ) : null}

      <nav className="main-tabs">
        <button className={mainView === "report" ? "active" : ""} onClick={() => setMainView("report")}>Report</button>
        <button className={mainView === "graph" ? "active" : ""} onClick={() => setMainView("graph")}>Graph</button>
      </nav>

      {mainView === "graph" ? (
        <GraphExplorer dbName={dbName} runId={runId} />
      ) : (
        <>
      <nav className="workspace-tabs">
        {workspaceOrder.map((key) => {
          const entry = summary?.workspaces.find((candidate) => candidate.workspace === key);
          return (
            <button key={key} className={workspace === key ? "active" : ""} onClick={() => switchWorkspace(key)}>
              <span>{entry?.label ?? labelWorkspace(key)}</span>
              <strong>{entry?.count ?? 0}</strong>
            </button>
          );
        })}
      </nav>

      <section className="filters">
        <label>
          <span>Search</span>
          <input value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} placeholder="ref, verb, path, reason, source" />
        </label>
        <label>
          <span>Bucket</span>
          <select value={bucket} onChange={(event) => switchBucket(event.target.value)}>
            <option value="">All buckets ({selectedWorkspace?.count ?? 0})</option>
            {bucketOptions.map((entry) => <option key={entry.bucket} value={entry.bucket}>{entry.bucket} ({entry.count})</option>)}
          </select>
        </label>
        <label>
          <span>Reason</span>
          <select value={reason} onChange={(event) => { setReason(event.target.value); setOffset(0); }}>
            <option value="">All reasons ({reasonOptions.reduce((sum, entry) => sum + entry.count, 0)})</option>
            {reasonOptions.map((entry) => <option key={entry.reason} value={entry.reason}>{entry.reason} ({entry.count})</option>)}
          </select>
        </label>
      </section>

      <section className="bucket-strip">
        {bucketOptions.map((entry) => (
          <button key={entry.bucket} className={bucket === entry.bucket ? "active" : ""} onClick={() => switchBucket(bucket === entry.bucket ? "" : entry.bucket)}>
            {entry.bucket}<strong>{entry.count}</strong>
          </button>
        ))}
      </section>

      <section className="results-head">
        <div>{itemsPage ? `${itemsPage.total} results` : "Loading results"}</div>
        <div>{itemsPage && itemsPage.total ? `${itemsPage.offset + 1}-${pageEnd}` : "0-0"}</div>
      </section>

      <section className="results">
        {itemsPage?.items.map((item) => <IssueRow key={`${item.ref}-${item.sourcePath}-${item.line}-${item.column}-${item.reason}`} item={item} />)}
        {itemsPage && itemsPage.items.length === 0 ? <div className="empty">No results match the current filters.</div> : null}
      </section>

      <footer className="pager">
        <button disabled={!itemsPage || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>
        <button disabled={!itemsPage || pageEnd >= itemsPage.total} onClick={() => setOffset(offset + 50)}>Next</button>
      </footer>
        </>
      )}
    </main>
  );
}

function GraphExplorer({ dbName, runId }: { dbName: string; runId: string }) {
  const [mode, setMode] = useState<GraphMode>("scoped");
  const [overviewMode, setOverviewMode] = useState<"call" | "object">("call");
  const [layoutMode, setLayoutMode] = useState<GraphLayoutMode>("classic");
  const [labelMode, setLabelMode] = useState<GraphLabelMode>("auto");
  const [graphDepth, setGraphDepth] = useState(1);
  const [graphLimit, setGraphLimit] = useState(GRAPH_LIMIT);
  const [visibleEdgeKinds, setVisibleEdgeKinds] = useState<Set<string>>(() => new Set(DEFAULT_VISIBLE_EDGE_KINDS));
  const [focusMode, setFocusMode] = useState(true);
  const [showObjectMembers, setShowObjectMembers] = useState(false);
  const [query, setQuery] = useState("");
  const [sourceVerbId, setSourceVerbId] = useState("");
  const [searchResults, setSearchResults] = useState<GraphSearchResult[]>([]);
  const [graph, setGraph] = useState<GraphPayload | undefined>();
  const [graphHistory, setGraphHistory] = useState<GraphPayload[]>([]);
  const [selected, setSelected] = useState<GraphNode | GraphEdge | undefined>();
  const [breadcrumbs, setBreadcrumbs] = useState<GraphBreadcrumb[]>([]);
  const [pathState, setPathState] = useState<GraphPathState>({ ids: new Set() });
  const [layoutRunKey, setLayoutRunKey] = useState(0);
  const [expandAnchorId, setExpandAnchorId] = useState<string | undefined>();
  const [graphError, setGraphError] = useState("");
  const [graphLoad, setGraphLoad] = useState<{ label: string; startedAt: number } | undefined>();
  const [graphLoadElapsedSeconds, setGraphLoadElapsedSeconds] = useState(0);
  const graphRequestRef = useRef(0);

  useEffect(() => {
    graphRequestRef.current += 1;
    setGraph(undefined);
    setGraphHistory([]);
    setSelected(undefined);
    setBreadcrumbs([]);
    setPathState({ ids: new Set() });
    setExpandAnchorId(undefined);
    setSearchResults([]);
    setGraphError("");
    setGraphLoad(undefined);
    setGraphLoadElapsedSeconds(0);
  }, [dbName, runId]);

  useEffect(() => {
    if (!graphLoad) return;
    setGraphLoadElapsedSeconds(Math.max(0, Math.floor((Date.now() - graphLoad.startedAt) / 1000)));
    const timer = window.setInterval(() => {
      setGraphLoadElapsedSeconds(Math.max(0, Math.floor((Date.now() - graphLoad.startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [graphLoad]);

  useEffect(() => {
    if (!dbName || !runId || !query.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      loadJson<{ results: GraphSearchResult[] }>(`/api/reports/${encodeURIComponent(dbName)}/${encodeURIComponent(runId)}/graph/search?q=${encodeURIComponent(query.trim())}`)
        .then((next) => setSearchResults(next.results))
        .catch((cause) => setGraphError(errorMessage(cause)));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [dbName, runId, query]);

  function loadGraph(label: string, path: string, options: { saveCurrent?: boolean } = {}) {
    if (!dbName || !runId) return;
    if (options.saveCurrent && graph) setGraphHistory((current) => [...current.slice(-9), graph]);
    setExpandAnchorId(undefined);
    const requestId = graphRequestRef.current + 1;
    graphRequestRef.current = requestId;
    setGraphError("");
    setGraphLoad({ label, startedAt: Date.now() });
    setGraphLoadElapsedSeconds(0);
    loadJson<GraphPayload>(path)
      .then((next) => {
        if (requestId !== graphRequestRef.current) return;
        setGraph(next);
        setSelected(undefined);
        setPathState({ ids: new Set() });
        setLayoutRunKey((current) => current + 1);
      })
      .catch((cause) => {
        if (requestId !== graphRequestRef.current) return;
        setGraphError(errorMessage(cause));
      })
      .finally(() => {
        if (requestId !== graphRequestRef.current) return;
        setGraphLoad(undefined);
      });
  }

  function loadOverview() {
    if (!dbName || !runId || graphLoad) return;
    loadGraph("Loading whole DB map", `/api/reports/${encodeURIComponent(dbName)}/${encodeURIComponent(runId)}/graph/overview?mode=${overviewMode}&limit=${graphLimit}`);
  }

  function loadSourceVerb(nextSourceVerbId = sourceVerbId) {
    if (!dbName || !runId || !nextSourceVerbId.trim() || graphLoad) return;
    loadGraph(
      `Loading ${stripGraphPrefix(nextSourceVerbId.trim())}`,
      `/api/reports/${encodeURIComponent(dbName)}/${encodeURIComponent(runId)}/graph/source-verb/${encodeURIComponent(stripGraphPrefix(nextSourceVerbId.trim()))}?limit=${graphLimit}`
    );
  }

  function loadNeighborhood(seed: string) {
    if (!dbName || !runId || !seed.trim() || graphLoad) return;
    pushBreadcrumb(seed, graphNodeLabel(graph, seed));
    loadGraph(
      `Loading neighborhood for ${seed.trim()}`,
      `/api/reports/${encodeURIComponent(dbName)}/${encodeURIComponent(runId)}/graph/neighborhood?seed=${encodeURIComponent(seed.trim())}&depth=${graphDepth}&limit=${graphLimit}`,
      { saveCurrent: true }
    );
  }

  function expandNeighborhoodInPlace(seed: string, expandMode: GraphExpandMode = "all") {
    if (!dbName || !runId || !seed.trim() || graphLoad) return;
    pushBreadcrumb(seed, graphNodeLabel(graph, seed));
    const requestId = graphRequestRef.current + 1;
    graphRequestRef.current = requestId;
    if (graph) setGraphHistory((current) => [...current.slice(-9), graph]);
    setGraphError("");
    setGraphLoad({ label: `Expanding ${labelExpandMode(expandMode)} for ${seed.trim()}`, startedAt: Date.now() });
    setGraphLoadElapsedSeconds(0);
    loadJson<GraphPayload>(
      `/api/reports/${encodeURIComponent(dbName)}/${encodeURIComponent(runId)}/graph/neighborhood?seed=${encodeURIComponent(seed.trim())}&depth=${graphDepth}&limit=${graphLimit}`
    )
      .then((next) => {
        if (requestId !== graphRequestRef.current) return;
        const scoped = filterExpansionGraph(next, seed, expandMode);
        setGraph((current) => current ? mergeGraphPayload(current, scoped) : scoped);
        setSelected(undefined);
        setPathState({ ids: new Set() });
        setExpandAnchorId(seed);
      })
      .catch((cause) => {
        if (requestId !== graphRequestRef.current) return;
        setGraphError(errorMessage(cause));
      })
      .finally(() => {
        if (requestId !== graphRequestRef.current) return;
        setGraphLoad(undefined);
      });
  }

  function restorePreviousGraph() {
    const previous = graphHistory.at(-1);
    if (!previous) return;
    setGraph(previous);
    setSelected(undefined);
    setPathState({ ids: new Set() });
    setExpandAnchorId(undefined);
    setLayoutRunKey((current) => current + 1);
    setGraphHistory((current) => current.slice(0, -1));
  }

  function toggleEdgeKind(kind: string) {
    setVisibleEdgeKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function showAllEdges() {
    setVisibleEdgeKinds(new Set(EDGE_KIND_OPTIONS));
  }

  function showCoreEdges() {
    setVisibleEdgeKinds(new Set(DEFAULT_VISIBLE_EDGE_KINDS));
  }

  function openResult(result: GraphSearchResult) {
    pushBreadcrumb(result.id, result.label);
    if (result.kind === "verb" || result.kind === "issue") {
      setSourceVerbId(stripGraphPrefix(result.id));
      if (mode === "source") loadSourceVerb(result.id);
      else loadNeighborhood(result.id);
      return;
    }
    loadNeighborhood(result.id);
  }

  function selectGraphNode(nodeId: string) {
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      loadNeighborhood(nodeId);
      return;
    }
    setSelected(node);
    pushBreadcrumb(node.id, node.label);
  }

  function pushBreadcrumb(id: string, label?: string) {
    setBreadcrumbs((current) => {
      const crumb = { id, label: label || id };
      const existingIndex = current.findIndex((entry) => entry.id === id);
      const next = existingIndex >= 0 ? current.slice(0, existingIndex + 1) : [...current, crumb];
      if (existingIndex >= 0) next[existingIndex] = crumb;
      return next.slice(-8);
    });
  }

  function setPathEndpoint(which: "start" | "end", nodeId: string) {
    const next = {
      ...pathState,
      [which === "start" ? "startId" : "endId"]: nodeId,
      ids: new Set<string>(),
      message: undefined
    };
    setPathState(next);
  }

  function findPath() {
    if (!graph || !pathState.startId || !pathState.endId) return;
    const path = shortestGraphPath(graph, pathState.startId, pathState.endId, visibleEdgeKinds);
    if (!path) {
      setPathState((current) => ({ ...current, ids: new Set(), message: "No path in current graph" }));
      return;
    }
    const edgeCount = graph.edges.filter((edge) => path.has(edge.id)).length;
    setPathState((current) => ({ ...current, ids: path, message: `${edgeCount} edges` }));
  }

  function clearPath() {
    setPathState({ ids: new Set() });
  }

  return (
    <section className="graph-workspace">
      <div className="graph-toolbar">
        <label>
          <span>Mode</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as GraphMode)}>
            <option value="scoped">Scoped Explorer</option>
            <option value="overview">Whole DB Map</option>
            <option value="source">Source Verb</option>
          </select>
        </label>
        {mode === "overview" ? (
          <label>
            <span>Overview</span>
            <select value={overviewMode} onChange={(event) => setOverviewMode(event.target.value as "call" | "object")}>
              <option value="call">Call Graph</option>
              <option value="object">Object Graph</option>
            </select>
          </label>
        ) : null}
        {mode === "source" ? (
          <label>
            <span>Source Verb</span>
            <input value={sourceVerbId} onChange={(event) => setSourceVerbId(event.target.value)} placeholder="#20:0" />
          </label>
        ) : (
          <label>
            <span>Search Graph</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="verb, object, core symbol, issue" />
          </label>
        )}
        <button className={`primary-action ${graphLoad ? "loading" : ""}`} disabled={!dbName || !runId || !!graphLoad} onClick={() => mode === "overview" ? loadOverview() : mode === "source" ? loadSourceVerb() : query.trim() && searchResults[0] ? openResult(searchResults[0]) : undefined}>
          {graphLoad ? `Loading... ${graphLoadElapsedSeconds}s` : "Load Graph"}
        </button>
      </div>

      <div className="graph-controls">
        <label>
          <span>Layout</span>
          <select value={layoutMode} onChange={(event) => {
            setLayoutMode(event.target.value as GraphLayoutMode);
            setExpandAnchorId(undefined);
            setLayoutRunKey((current) => current + 1);
          }}>
            <option value="wide">Wide</option>
            <option value="classic">Classic</option>
            <option value="layered">Layered</option>
            <option value="force">Force</option>
            <option value="coseBilkent">CoSE Bilkent</option>
            <option value="cola">Cola</option>
            <option value="euler">Euler</option>
            <option value="klay">Klay</option>
            <option value="concentric">Concentric</option>
          </select>
        </label>
        <label>
          <span>Depth</span>
          <select value={graphDepth} onChange={(event) => setGraphDepth(Number(event.target.value))}>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        <label>
          <span>Max Nodes</span>
          <select value={graphLimit} onChange={(event) => setGraphLimit(Number(event.target.value))}>
            <option value={100}>100</option>
            <option value={300}>300</option>
            <option value={750}>750</option>
            <option value={1500}>1500</option>
          </select>
        </label>
        <label>
          <span>Labels</span>
          <select value={labelMode} onChange={(event) => setLabelMode(event.target.value as GraphLabelMode)}>
            <option value="auto">Auto</option>
            <option value="compact">Compact</option>
            <option value="full">Full</option>
          </select>
        </label>
        <label className="graph-toggle">
          <input type="checkbox" checked={focusMode} onChange={(event) => setFocusMode(event.target.checked)} />
          <span>Focus Selection</span>
        </label>
        <label className="graph-toggle">
          <input type="checkbox" checked={showObjectMembers} onChange={(event) => setShowObjectMembers(event.target.checked)} />
          <span>Object Members</span>
        </label>
      </div>

      <div className="graph-edge-filters">
        <span>Edges</span>
        {EDGE_KIND_OPTIONS.map((kind) => (
          <label key={kind}>
            <input type="checkbox" checked={visibleEdgeKinds.has(kind)} onChange={() => toggleEdgeKind(kind)} />
            <span>{kind}</span>
          </label>
        ))}
        <button onClick={showCoreEdges}>Core</button>
        <button onClick={showAllEdges}>All</button>
      </div>

      <div className="graph-legend">
        <span>Legend</span>
        <i className="legend-node legend-object" /> Object
        <i className="legend-node legend-verb" /> Verb
        <i className="legend-node legend-property" /> Property
        <i className="legend-node legend-runtime" /> Runtime
        <i className="legend-node legend-unresolved" /> Unresolved
        <i className="legend-line legend-call" /> Call
        <i className="legend-line legend-property-edge" /> Property
        <i className="legend-line legend-inheritance" /> Inheritance
        <i className="legend-line legend-contains" /> Contains
      </div>

      {breadcrumbs.length ? (
        <div className="graph-breadcrumbs" aria-label="Graph breadcrumbs">
          <span>Trail</span>
          {breadcrumbs.map((crumb, index) => (
            <React.Fragment key={`${crumb.id}-${index}`}>
              {index > 0 ? <b>/</b> : null}
              <button onClick={() => selectGraphNode(crumb.id)}>{crumb.label}</button>
            </React.Fragment>
          ))}
          <button onClick={() => setBreadcrumbs([])}>Clear</button>
        </div>
      ) : null}

      <div className="graph-path-panel">
        <span>Path</span>
        <code>{pathState.startId ? graphNodeLabel(graph, pathState.startId) : "start not set"}</code>
        <b>to</b>
        <code>{pathState.endId ? graphNodeLabel(graph, pathState.endId) : "end not set"}</code>
        <button disabled={!graph || !pathState.startId || !pathState.endId} onClick={findPath}>Find Path</button>
        <button disabled={!pathState.startId && !pathState.endId && !pathState.ids.size} onClick={clearPath}>Clear</button>
        {pathState.message ? <em>{pathState.message}</em> : null}
      </div>

      {graphLoad ? (
        <div className="notice graph-loading" role="status" aria-live="polite">
          <strong>{graphLoad.label}</strong>
          <span>Still working after {graphLoadElapsedSeconds}s. For large DBs, this could take a bit.</span>
        </div>
      ) : null}
      {graphError ? <div className="notice error">{graphError}</div> : null}
      {mode !== "source" && searchResults.length ? (
        <div className="graph-search-results">
          {searchResults.map((result) => (
            <button key={`${result.kind}-${result.id}-${result.detail ?? ""}`} disabled={!!graphLoad} onClick={() => openResult(result)}>
              <strong>{result.label}</strong>
              <span>{result.kind}{result.detail ? ` - ${result.detail}` : ""}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="graph-layout">
        <GraphCanvas
          graph={graph}
          layoutMode={layoutMode}
          labelMode={labelMode}
          visibleEdgeKinds={visibleEdgeKinds}
          focusMode={focusMode}
          showObjectMembers={showObjectMembers}
          selected={selected}
          pathIds={pathState.ids}
          layoutRunKey={layoutRunKey}
          expandAnchorId={expandAnchorId}
          canGoBack={graphHistory.length > 0}
          onBack={restorePreviousGraph}
          onRelayout={() => {
            setExpandAnchorId(undefined);
            setLayoutRunKey((current) => current + 1);
          }}
          onSelect={setSelected}
        />
        <GraphDetails
          selected={selected}
          graph={graph}
          onClearSelection={() => setSelected(undefined)}
          onSetPathStart={(nodeId) => setPathEndpoint("start", nodeId)}
          onSetPathEnd={(nodeId) => setPathEndpoint("end", nodeId)}
          onExpand={expandNeighborhoodInPlace}
          onReplace={(nodeId) => loadNeighborhood(nodeId)}
        />
      </div>
    </section>
  );
}

function GraphCanvas({
  graph,
  layoutMode,
  labelMode,
  visibleEdgeKinds,
  focusMode,
  showObjectMembers,
  selected,
  pathIds,
  layoutRunKey,
  expandAnchorId,
  canGoBack,
  onBack,
  onRelayout,
  onSelect
}: {
  graph?: GraphPayload;
  layoutMode: GraphLayoutMode;
  labelMode: GraphLabelMode;
  visibleEdgeKinds: Set<string>;
  focusMode: boolean;
  showObjectMembers: boolean;
  selected?: GraphNode | GraphEdge;
  pathIds: Set<string>;
  layoutRunKey: number;
  expandAnchorId?: string;
  canGoBack: boolean;
  onBack: () => void;
  onRelayout: () => void;
  onSelect: (selected: GraphNode | GraphEdge | undefined) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | undefined>();
  const layoutRunKeyRef = useRef(layoutRunKey);
  const [zoom, setZoom] = useState(1);
  const [miniMap, setMiniMap] = useState<MiniMapState | undefined>();
  const [graphAction, setGraphAction] = useState("");
  const graphActionTimerRef = useRef<number | undefined>();

  useEffect(() => {
    if (!containerRef.current) return;
    if (!graph) {
      cyRef.current?.destroy();
      cyRef.current = undefined;
      setMiniMap(undefined);
      return;
    }

    let cy = cyRef.current;
    if (!cy) {
      cy = cytoscape({
        container: containerRef.current,
        elements: [],
        minZoom: MIN_GRAPH_ZOOM,
        maxZoom: MAX_GRAPH_ZOOM,
        wheelSensitivity: 0.52,
        style: graphStyle(),
        layout: { name: "preset" }
      });
      cy.on("zoom pan resize", () => {
        setZoom(cy!.zoom());
        updateGraphLabels(cy!, labelMode);
        setMiniMap(readMiniMapState(cy!));
      });
      cy.on("layoutstop dragfree", () => setMiniMap(readMiniMapState(cy!)));
      cy.on("tap", "node, edge", (event: EventObject) => onSelect(event.target.data() as GraphNode | GraphEdge));
      cy.on("dbltap", "node", (event: EventObject) => {
        const node = event.target;
        cy!.animate(
          {
            center: { eles: node },
            zoom: Math.min(MAX_GRAPH_ZOOM, Math.max(cy!.zoom() * 1.5, DOUBLE_TAP_ZOOM))
          },
          { duration: 240 }
        );
      });
      cy.on("mouseover", "node, edge", (event: EventObject) => event.target.addClass("hover"));
      cy.on("mouseout", "node, edge", (event: EventObject) => event.target.removeClass("hover"));
      cy.on("tap", (event: EventObject) => {
        if (event.target === cy) onSelect(undefined);
      });
      cyRef.current = cy;
    }

    syncCytoscapeElements(cy, graph, visibleEdgeKinds, showObjectMembers, expandAnchorId);
    updateGraphLabels(cy, labelMode);
    updateGraphFocus(cy, selected, focusMode);
    updateGraphPath(cy, pathIds);

    if (layoutRunKeyRef.current !== layoutRunKey) {
      layoutRunKeyRef.current = layoutRunKey;
      runGraphLayout(cy, graph, layoutMode);
    } else if (expandAnchorId) {
      placeNewNodesAroundAnchor(cy, expandAnchorId);
    }

    setZoom(cy.zoom());
    setMiniMap(readMiniMapState(cy));
  }, [graph, visibleEdgeKinds, showObjectMembers, layoutMode, layoutRunKey, expandAnchorId, labelMode, selected, focusMode, pathIds, onSelect]);

  useEffect(() => {
    return () => {
      if (graphActionTimerRef.current !== undefined) window.clearTimeout(graphActionTimerRef.current);
      cyRef.current?.destroy();
      cyRef.current = undefined;
    };
  }, []);

  function showGraphAction(message: string, minimumMs = 0) {
    if (graphActionTimerRef.current !== undefined) window.clearTimeout(graphActionTimerRef.current);
    setGraphAction(message);
    if (minimumMs > 0) {
      graphActionTimerRef.current = window.setTimeout(() => {
        setGraphAction("");
        graphActionTimerRef.current = undefined;
      }, minimumMs);
    }
  }

  function runGraphLayout(cy: Core, nextGraph: GraphPayload, nextLayoutMode: GraphLayoutMode) {
    showGraphAction(`Applying ${labelGraphLayoutMode(nextLayoutMode)} layout...`);
    window.setTimeout(() => {
      if (cyRef.current !== cy) return;
      const startedAt = Date.now();
      const layout = cy.layout({
        ...graphLayout(nextGraph, nextLayoutMode),
        stop: () => {
          setMiniMap(readMiniMapState(cy));
          const remainingMs = Math.max(0, 450 - (Date.now() - startedAt));
          window.setTimeout(() => showGraphAction(`Applied ${labelGraphLayoutMode(nextLayoutMode)} layout`, 1200), remainingMs);
        }
      });
      layout.run();
    }, 50);
  }

  function setGraphZoom(nextZoom: number) {
    const cy = cyRef.current;
    if (!cy) return;
    const clamped = Math.min(MAX_GRAPH_ZOOM, Math.max(MIN_GRAPH_ZOOM, nextZoom));
    cy.zoom({
      level: clamped,
      renderedPosition: {
        x: cy.width() / 2,
        y: cy.height() / 2
      }
    });
    updateGraphLabels(cy, labelMode);
    setZoom(clamped);
    setMiniMap(readMiniMapState(cy));
  }

  function fitGraph() {
    const cy = cyRef.current;
    if (!cy) return;
    showGraphAction("Fitting graph...");
    window.setTimeout(() => {
      if (cyRef.current !== cy) return;
      cy.animate(
        { fit: { eles: cy.elements(), padding: 24 } },
        {
          duration: 220,
          complete: () => {
            showGraphAction("Fit complete", 900);
            setMiniMap(readMiniMapState(cy));
          }
        }
      );
    }, 30);
  }

  return (
    <div className="graph-panel">
      <div className="graph-meta">
        <span>{graph ? graphMetaText(graph) : "Load a graph to begin"}</span>
        <div className="graph-actions">
          <button disabled={!canGoBack} onClick={onBack}>Back</button>
          <button disabled={!graph || graphAction.startsWith("Applying")} onClick={onRelayout}>
            {graphAction.startsWith("Applying") ? "Layout..." : "Apply Layout"}
          </button>
          <button disabled={!graph || graphAction.startsWith("Fitting")} onClick={fitGraph}>
            {graphAction.startsWith("Fitting") ? "Fit..." : "Fit"}
          </button>
        </div>
      </div>
      <div className="graph-viewport">
        <div className="graph-canvas" ref={containerRef} />
        {graphAction ? <div className="graph-action-busy" role="status" aria-live="polite">{graphAction}</div> : null}
        <label className="graph-zoom">
          <span>Zoom</span>
          <input
            aria-label="Graph zoom"
            type="range"
            min={MIN_GRAPH_ZOOM}
            max={MAX_GRAPH_ZOOM}
            step="0.02"
            value={zoom}
            disabled={!graph}
            onChange={(event) => setGraphZoom(Number(event.target.value))}
          />
        </label>
        <GraphMiniMap
          state={miniMap}
          onNavigate={(x, y) => {
            const cy = cyRef.current;
            if (!cy) return;
            const zoomLevel = cy.zoom();
            cy.animate(
              {
                pan: {
                  x: cy.width() / 2 - x * zoomLevel,
                  y: cy.height() / 2 - y * zoomLevel
                }
              },
              { duration: 180 }
            );
          }}
        />
      </div>
    </div>
  );
}

interface MiniMapState {
  nodes: Array<{ id: string; x: number; y: number; kind: string }>;
  bounds: { x1: number; y1: number; w: number; h: number };
  viewport: { x1: number; y1: number; w: number; h: number };
}

function GraphMiniMap({ state, onNavigate }: { state?: MiniMapState; onNavigate: (x: number, y: number) => void }) {
  if (!state || !state.nodes.length) return null;
  const width = 148;
  const height = 96;
  const pad = 8;
  const scale = Math.min((width - pad * 2) / Math.max(1, state.bounds.w), (height - pad * 2) / Math.max(1, state.bounds.h));
  const offsetX = pad - state.bounds.x1 * scale + (width - pad * 2 - state.bounds.w * scale) / 2;
  const offsetY = pad - state.bounds.y1 * scale + (height - pad * 2 - state.bounds.h * scale) / 2;
  const view = {
    x: offsetX + state.viewport.x1 * scale,
    y: offsetY + state.viewport.y1 * scale,
    w: Math.max(4, state.viewport.w * scale),
    h: Math.max(4, state.viewport.h * scale)
  };
  function navigate(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * width;
    const svgY = ((event.clientY - rect.top) / rect.height) * height;
    onNavigate((svgX - offsetX) / scale, (svgY - offsetY) / scale);
  }

  return (
    <svg className="graph-minimap" viewBox={`0 0 ${width} ${height}`} aria-label="Graph overview" onPointerDown={navigate}>
      <rect className="graph-minimap-bg" x="0" y="0" width={width} height={height} rx="6" />
      {state.nodes.slice(0, 500).map((node) => (
        <circle
          key={node.id}
          className={`mini-node mini-node-${node.kind}`}
          cx={offsetX + node.x * scale}
          cy={offsetY + node.y * scale}
          r={node.kind === "object" ? 2.2 : 1.6}
        />
      ))}
      <rect className="graph-minimap-view" x={view.x} y={view.y} width={view.w} height={view.h} />
    </svg>
  );
}

function graphStyle(): Css.Stylesheet[] {
  return [
    {
      selector: "node",
      style: {
        label: "data(displayLabel)",
        "font-size": 11,
        "font-weight": 600,
        "min-zoomed-font-size": 7,
        "text-wrap": "wrap",
        "text-max-width": 140,
        "text-background-color": "#ffffff",
        "text-background-opacity": 0.9,
        "text-background-padding": "3px",
        "text-border-color": "#d7dde5",
        "text-border-opacity": 0.9,
        "text-border-width": 1,
        "background-color": "#607d8b",
        color: "#1e2936",
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 8,
        width: 30,
        height: 30,
        "border-width": 1,
        "border-color": "#ffffff",
        "overlay-opacity": 0
      }
    },
    { selector: ".node-verb", style: { "background-color": "#0f766e", shape: "round-rectangle", width: 48, height: 30 } },
    {
      selector: ".node-object",
      style: {
        "background-color": "#175cd3",
        shape: "round-rectangle",
        width: 104,
        height: 42,
        color: "#ffffff",
        "text-valign": "center",
        "text-halign": "center",
        "text-margin-y": 0,
        "text-max-width": 96,
        "text-background-opacity": 0,
        "text-border-opacity": 0
      }
    },
    { selector: ".node-property", style: { "background-color": "#b54708", shape: "diamond", width: 32, height: 32 } },
    { selector: ".node-runtime", style: { "background-color": "#7a5af8", shape: "hexagon", width: 34, height: 34 } },
    { selector: ".node-unresolved", style: { "background-color": "#b42318", shape: "triangle", width: 36, height: 36 } },
    { selector: ".node-core", style: { "background-color": "#0086c9", shape: "tag", width: 40, height: 30 } },
    { selector: ".node-summary", style: { "background-color": "#667085", shape: "barrel", width: 44, height: 32 } },
    {
      selector: "edge",
      style: {
        label: "data(label)",
        "font-size": 9,
        "min-zoomed-font-size": 8,
        "text-rotation": "autorotate",
        "text-background-color": "#ffffff",
        "text-background-opacity": 0.86,
        "text-background-padding": "2px",
        "text-margin-y": -8,
        width: 1.6,
        "line-color": "#98a2b3",
        "target-arrow-color": "#98a2b3",
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.8,
        "curve-style": "bezier",
        "control-point-step-size": 48,
        opacity: 0.78,
        "overlay-opacity": 0
      }
    },
    { selector: ".edge-call", style: { "line-color": "#0f766e", "target-arrow-color": "#0f766e" } },
    { selector: ".edge-property", style: { "line-color": "#b54708", "target-arrow-color": "#b54708" } },
    { selector: ".edge-guarded", style: { "line-color": "#7a5af8", "target-arrow-color": "#7a5af8", "line-style": "dashed" } },
    { selector: ".edge-unresolved", style: { "line-color": "#b42318", "target-arrow-color": "#b42318", "line-style": "dashed" } },
    { selector: ".edge-inheritance", style: { "line-color": "#175cd3", "target-arrow-color": "#175cd3" } },
    { selector: ".edge-contains", style: { "line-color": "#667085", "target-arrow-color": "#667085", "line-style": "dotted", opacity: 0.55 } },
    { selector: ".graph-dim", style: { opacity: 0.12, "text-opacity": 0.08 } },
    { selector: ".graph-focus", style: { opacity: 1, "text-opacity": 1, "z-index": 900 } },
    { selector: "node.graph-focus", style: { "border-width": 3, "border-color": "#111827" } },
    { selector: ".graph-path", style: { opacity: 1, "text-opacity": 1, "z-index": 950 } },
    { selector: "node.graph-path", style: { "border-width": 4, "border-color": "#f59e0b" } },
    { selector: "edge.graph-path", style: { width: 4, "line-color": "#f59e0b", "target-arrow-color": "#f59e0b" } },
    { selector: "node.hover", style: { "z-index": 999, "border-width": 3, "border-color": "#111827" } },
    { selector: "edge.hover", style: { "z-index": 999, opacity: 1, width: 3 } },
    { selector: "node:selected", style: { "z-index": 1000, "border-width": 4, "border-color": "#111827" } },
    { selector: "edge:selected", style: { "z-index": 1000, width: 4, opacity: 1, "line-color": "#111827", "target-arrow-color": "#111827" } }
  ];
}

function graphLayout(graph: GraphPayload, layoutMode: GraphLayoutMode): LayoutOptions {
  if (layoutMode === "wide") {
    const columns = Math.max(4, Math.ceil(Math.sqrt(graph.nodes.length) * 1.8));
    return {
      name: "grid",
      animate: true,
      animationDuration: 320,
      fit: true,
      padding: 64,
      avoidOverlap: true,
      avoidOverlapPadding: 90,
      nodeDimensionsIncludeLabels: true,
      spacingFactor: 1.85,
      cols: columns,
      sort: (a: { data: (key: string) => unknown }, b: { data: (key: string) => unknown }) => graphNodeSortKey(a).localeCompare(graphNodeSortKey(b))
    };
  }

  if (layoutMode === "layered") {
    return {
      name: "dagre",
      animate: true,
      animationDuration: 320,
      fit: true,
      padding: 64,
      rankDir: "LR",
      nodeSep: 42,
      edgeSep: 36,
      rankSep: 230,
      ranker: "longest-path",
      spacingFactor: 0.82,
      boundingBox: wideLayoutBounds(graph.nodes.length),
      transform: (_node: unknown, position: { x: number; y: number }) => ({ x: position.x * 1.15, y: position.y * 0.58 })
    };
  }

  if (layoutMode === "force") {
    return {
      name: "fcose",
      animate: true,
      animationDuration: 320,
      fit: true,
      padding: 64,
      nodeRepulsion: graph.nodes.length > 250 ? 18000 : 14000,
      idealEdgeLength: graph.nodes.length > 250 ? 210 : 260,
      edgeElasticity: 0.18,
      nestingFactor: 0.1,
      gravity: 0.08,
      numIter: 3200,
      nodeDimensionsIncludeLabels: true
    };
  }

  if (layoutMode === "coseBilkent") {
    return {
      name: "cose-bilkent",
      animate: "end",
      animationDuration: 320,
      fit: true,
      padding: 64,
      randomize: false,
      nodeDimensionsIncludeLabels: true,
      nodeRepulsion: graph.nodes.length > 250 ? 9000 : 7000,
      idealEdgeLength: graph.nodes.length > 250 ? 170 : 220,
      edgeElasticity: 0.35,
      nestingFactor: 0.1,
      gravity: 0.12,
      numIter: 1800,
      tile: true,
      tilingPaddingVertical: 70,
      tilingPaddingHorizontal: 90
    };
  }

  if (layoutMode === "cola") {
    return {
      name: "cola",
      animate: "end",
      refresh: 2,
      maxSimulationTime: 2200,
      ungrabifyWhileSimulating: true,
      fit: true,
      padding: 64,
      randomize: false,
      avoidOverlap: true,
      handleDisconnected: true,
      nodeSpacing: 36,
      edgeLength: graph.nodes.length > 250 ? 180 : 230,
      convergenceThreshold: 0.02,
      centerGraph: true
    };
  }

  if (layoutMode === "euler") {
    return {
      name: "euler",
      animate: "end",
      animationDuration: 320,
      fit: true,
      padding: 64,
      randomize: false,
      maxIterations: graph.nodes.length > 250 ? 1500 : 1000,
      maxSimulationTime: 2400,
      springLength: graph.nodes.length > 250 ? 150 : 210,
      springCoeff: 0.0008,
      mass: (node: { degree: () => number }) => 4 + node.degree(),
      gravity: -1.2,
      pull: 0.002,
      theta: 0.666
    };
  }

  if (layoutMode === "klay") {
    return {
      name: "klay",
      animate: true,
      animationDuration: 320,
      fit: true,
      padding: 64,
      nodeDimensionsIncludeLabels: true,
      klay: {
        direction: "RIGHT",
        edgeRouting: "ORTHOGONAL",
        fixedAlignment: "BALANCED",
        nodeLayering: "NETWORK_SIMPLEX",
        nodePlacement: "BRANDES_KOEPF",
        spacing: 70,
        inLayerSpacingFactor: 1.2,
        thoroughness: 5,
        randomizationSeed: 1
      }
    };
  }

  if (layoutMode === "classic") {
    if (graph.mode === "overview") {
      return {
        name: "cose",
        animate: true,
        animationDuration: 320,
        fit: true,
        padding: 52,
        randomize: false,
        nodeRepulsion: graph.nodes.length > 250 ? 420000 : 320000,
        nodeOverlap: 36,
        idealEdgeLength: graph.nodes.length > 250 ? 210 : 240,
        edgeElasticity: 80,
        nestingFactor: 1.2,
        gravity: 0.18,
        numIter: 2200,
        componentSpacing: 220,
        nodeDimensionsIncludeLabels: true
      };
    }

    return {
      name: "breadthfirst",
      directed: true,
      animate: true,
      animationDuration: 320,
      fit: true,
      padding: 52,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
      spacingFactor: graph.nodes.length > 160 ? 2.2 : 2.8,
      circle: false
    };
  }

  return {
    name: "concentric",
    animate: true,
    animationDuration: 320,
    fit: true,
    padding: 64,
    avoidOverlap: true,
    minNodeSpacing: 90,
    nodeDimensionsIncludeLabels: true,
    spacingFactor: 3.2,
    concentric: (node: { degree: () => number }) => node.degree(),
    levelWidth: () => 2
  };
}

function labelGraphLayoutMode(layoutMode: GraphLayoutMode): string {
  if (layoutMode === "wide") return "Wide";
  if (layoutMode === "classic") return "Classic";
  if (layoutMode === "layered") return "Layered";
  if (layoutMode === "force") return "Force";
  if (layoutMode === "coseBilkent") return "CoSE Bilkent";
  if (layoutMode === "cola") return "Cola";
  if (layoutMode === "euler") return "Euler";
  if (layoutMode === "klay") return "Klay";
  return "Concentric";
}

function wideLayoutBounds(nodeCount: number): { x1: number; y1: number; w: number; h: number } {
  const columns = Math.max(4, Math.ceil(Math.sqrt(nodeCount) * 1.8));
  const rows = Math.max(2, Math.ceil(nodeCount / columns));
  return {
    x1: 0,
    y1: 0,
    w: columns * 190,
    h: rows * 130
  };
}

function graphNodeSortKey(node: { data: (key: string) => unknown }): string {
  const kind = String(node.data("kind") ?? "");
  const object = String(node.data("object") ?? "");
  const label = String(node.data("label") ?? "");
  const rank = kind === "object" ? "0" : kind === "verb" ? "1" : kind === "property" ? "2" : "3";
  return `${rank}:${object}:${label}`;
}

function GraphDetails({
  selected,
  graph,
  onClearSelection,
  onSetPathStart,
  onSetPathEnd,
  onExpand,
  onReplace
}: {
  selected?: GraphNode | GraphEdge;
  graph?: GraphPayload;
  onClearSelection: () => void;
  onSetPathStart: (nodeId: string) => void;
  onSetPathEnd: (nodeId: string) => void;
  onExpand: (nodeId: string, expandMode?: GraphExpandMode) => void;
  onReplace: (nodeId: string) => void;
}) {
  if (!graph) return <aside className="graph-details empty">No graph loaded.</aside>;
  if (!selected) return <aside className="graph-details empty">Select a node or edge.</aside>;
  const isNode = !("source" in selected);
  return (
    <aside className="graph-details">
      <h2>{selected.label ?? selected.id}</h2>
      <dl>
        <div><dt>Type</dt><dd>{selected.kind}</dd></div>
        <div><dt>ID</dt><dd>{selected.id}</dd></div>
        {isNode && selected.object ? <div><dt>Object</dt><dd>{formatGraphObjectRef(selected)}</dd></div> : null}
        {isNode && selected.verbId ? <div><dt>Verb</dt><dd>{selected.verbId}</dd></div> : null}
        {!isNode ? <div><dt>Source</dt><dd>{selected.source}</dd></div> : null}
        {!isNode ? <div><dt>Target</dt><dd>{selected.target}</dd></div> : null}
        {!isNode && selected.sourceLocation ? <div><dt>Location</dt><dd>{`${selected.sourceLocation.sourcePath}:${selected.sourceLocation.line}:${selected.sourceLocation.column}`}</dd></div> : null}
      </dl>
      {isNode ? (
        <div className="graph-detail-actions">
          <button onClick={onClearSelection}>Clear Selection</button>
          <button onClick={() => onSetPathStart(selected.id)}>Set Path Start</button>
          <button onClick={() => onSetPathEnd(selected.id)}>Set Path End</button>
          <button className="primary-action" onClick={() => onExpand(selected.id)}>Expand In Place</button>
          <button onClick={() => onExpand(selected.id, "callers")}>Expand Callers</button>
          <button onClick={() => onExpand(selected.id, "callees")}>Expand Callees</button>
          <button onClick={() => onExpand(selected.id, "properties")}>Expand Properties</button>
          <button onClick={() => onExpand(selected.id, "objectMembers")}>Expand Object Members</button>
          <button onClick={() => onReplace(selected.id)}>Replace View</button>
        </div>
      ) : (
        <div className="graph-detail-actions">
          <button onClick={onClearSelection}>Clear Selection</button>
        </div>
      )}
      <pre>{JSON.stringify(selected.metadata ?? selected.counts ?? {}, null, 2)}</pre>
    </aside>
  );
}

function graphMetaText(graph: GraphPayload): string {
  const rendered = `${graph.nodes.length}/${graph.total.nodes} nodes, ${graph.edges.length}/${graph.total.edges} edges`;
  return graph.truncated ? `${rendered} (limited to ${graph.limit}; refine search to see omitted nodes)` : rendered;
}

function formatGraphObjectRef(node: GraphNode): string {
  const name = typeof node.metadata?.name === "string" ? node.metadata.name : "";
  return name ? `${node.object} ${name}` : node.object ?? "";
}

function graphNodeLabel(graph: GraphPayload | undefined, nodeId: string | undefined): string {
  if (!nodeId) return "";
  return graph?.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
}

function labelExpandMode(expandMode: GraphExpandMode): string {
  if (expandMode === "callers") return "callers";
  if (expandMode === "callees") return "callees";
  if (expandMode === "properties") return "properties";
  if (expandMode === "objectMembers") return "object members";
  return "neighbors";
}

function mergeGraphPayload(current: GraphPayload, next: GraphPayload): GraphPayload {
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  const edges = new Map(current.edges.map((edge) => [edge.id, edge]));
  for (const node of next.nodes) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }
  for (const edge of next.edges) {
    if (!edges.has(edge.id)) edges.set(edge.id, edge);
  }
  return {
    mode: current.mode,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated: current.truncated || next.truncated,
    limit: Math.max(current.limit, next.limit),
    total: {
      nodes: Math.max(current.total.nodes, next.total.nodes, nodes.size),
      edges: Math.max(current.total.edges, next.total.edges, edges.size)
    },
    seed: current.seed
  };
}

function filterExpansionGraph(graph: GraphPayload, seed: string, expandMode: GraphExpandMode): GraphPayload {
  if (expandMode === "all") return graph;
  const matchingEdges = graph.edges.filter((edge) => expansionEdgeMatches(edge, seed, expandMode));
  const nodeIds = new Set([seed]);
  for (const edge of matchingEdges) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    edges: matchingEdges,
    total: { nodes: nodeIds.size, edges: matchingEdges.length },
    truncated: graph.truncated
  };
}

function expansionEdgeMatches(edge: GraphEdge, seed: string, expandMode: GraphExpandMode): boolean {
  if (expandMode === "callers") return edge.kind === "call" && edge.target === seed;
  if (expandMode === "callees") return edge.kind === "call" && edge.source === seed;
  if (expandMode === "properties") return edge.kind === "property" && (edge.source === seed || edge.target === seed);
  if (expandMode === "objectMembers") return edge.kind === "contains" && (edge.source === seed || edge.target === seed);
  return edge.source === seed || edge.target === seed;
}

function syncCytoscapeElements(cy: Core, graph: GraphPayload, visibleEdgeKinds: Set<string>, showObjectMembers: boolean, expandAnchorId?: string): void {
  const filteredEdges = graph.edges.filter((edge) => visibleEdgeKinds.has(edge.kind) && (showObjectMembers || edge.kind !== "contains"));
  const memberNodeIds = showObjectMembers ? new Set<string>() : objectMemberNodeIds(graph.edges);
  const visibleNodeIds = new Set(graph.nodes.filter((node) => !memberNodeIds.has(node.id)).map((node) => node.id));
  for (const edge of filteredEdges) {
    if (memberNodeIds.has(edge.source) || memberNodeIds.has(edge.target)) continue;
    visibleNodeIds.add(edge.source);
    visibleNodeIds.add(edge.target);
  }

  const wantedIds = new Set<string>();
  const anchor = expandAnchorId ? cy.getElementById(expandAnchorId) : undefined;
  const anchorPosition = anchor?.length ? anchor.position() : undefined;

  for (const node of graph.nodes) {
    if (!visibleNodeIds.has(node.id)) continue;
    wantedIds.add(node.id);
    const existing = cy.getElementById(node.id);
    const nodeData = { ...node, displayLabel: compactGraphLabel(node) };
    if (existing.length) {
      existing.data(nodeData);
      existing.classes(`node-${node.kind}`);
    } else {
      const position = anchorPosition ? jitterPosition(anchorPosition, cy.nodes().length) : undefined;
      cy.add({ group: "nodes", data: nodeData, classes: `node-${node.kind}`, ...(position ? { position } : {}) });
    }
  }

  for (const edge of filteredEdges) {
    if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) continue;
    wantedIds.add(edge.id);
    const existing = cy.getElementById(edge.id);
    if (existing.length) {
      existing.data(edge);
      existing.classes(`edge-${edge.kind}`);
    } else {
      cy.add({ group: "edges", data: edge, classes: `edge-${edge.kind}` });
    }
  }

  cy.elements().forEach((element) => {
    if (!wantedIds.has(element.id())) element.remove();
  });
}

function objectMemberNodeIds(edges: GraphEdge[]): Set<string> {
  const containsTargets = new Set<string>();
  const connectedByGraphEdge = new Set<string>();
  for (const edge of edges) {
    if (edge.kind === "contains") {
      containsTargets.add(edge.target);
    } else {
      connectedByGraphEdge.add(edge.source);
      connectedByGraphEdge.add(edge.target);
    }
  }
  return new Set([...containsTargets].filter((id) => !connectedByGraphEdge.has(id)));
}

function placeNewNodesAroundAnchor(cy: Core, anchorId: string): void {
  const anchor = cy.getElementById(anchorId);
  if (!anchor.length) return;
  const anchorPosition = anchor.position();
  cy.nodes().forEach((node, index) => {
    if (node.position("x") === 0 && node.position("y") === 0) node.position(jitterPosition(anchorPosition, index));
  });
}

function jitterPosition(anchor: { x: number; y: number }, index: number): { x: number; y: number } {
  const angle = index * 1.618 * Math.PI;
  const radius = 180 + (index % 12) * 28;
  return {
    x: anchor.x + Math.cos(angle) * radius,
    y: anchor.y + Math.sin(angle) * radius
  };
}

function updateGraphLabels(cy: Core, labelMode: GraphLabelMode): void {
  const zoom = cy.zoom();
  cy.nodes().forEach((node) => {
    const data = node.data() as GraphNode;
    node.data("displayLabel", graphDisplayLabel(data, labelMode, zoom));
  });
}

function graphDisplayLabel(node: GraphNode, labelMode: GraphLabelMode, zoom: number): string {
  if (labelMode === "full") return node.label;
  if (labelMode === "compact") return compactGraphLabel(node);
  if (zoom < 0.65) return compactGraphLabel(node);
  if (zoom > 1.25) return node.label;
  return node.kind === "object" ? compactGraphLabel(node) : node.label;
}

function compactGraphLabel(node: GraphNode): string {
  if (node.kind === "object" && node.object) return node.object;
  if (node.kind === "verb" && node.verbId) return node.verbId;
  return node.label;
}

function updateGraphFocus(cy: Core, selected: GraphNode | GraphEdge | undefined, focusMode: boolean): void {
  cy.elements().removeClass("graph-dim graph-focus");
  if (!selected) {
    cy.elements().unselect();
    return;
  }
  const selectedElement = cy.getElementById(selected.id);
  if (!selectedElement.length) return;
  cy.elements().unselect();
  selectedElement.select();
  if (!focusMode) return;
  const neighborhood = selectedElement.closedNeighborhood();
  cy.elements().difference(neighborhood).addClass("graph-dim");
  neighborhood.addClass("graph-focus");
}

function updateGraphPath(cy: Core, pathIds: Set<string>): void {
  cy.elements().removeClass("graph-path");
  if (!pathIds.size) return;
  pathIds.forEach((id) => cy.getElementById(id).addClass("graph-path"));
}

function shortestGraphPath(graph: GraphPayload, startId: string, endId: string, visibleEdgeKinds: Set<string>): Set<string> | undefined {
  if (startId === endId) return new Set([startId]);
  const adjacency = new Map<string, Array<{ next: string; edgeId: string }>>();
  for (const edge of graph.edges) {
    if (!visibleEdgeKinds.has(edge.kind)) continue;
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source)!.push({ next: edge.target, edgeId: edge.id });
    adjacency.get(edge.target)!.push({ next: edge.source, edgeId: edge.id });
  }

  const queue = [startId];
  const visited = new Set([startId]);
  const previous = new Map<string, { nodeId: string; edgeId: string }>();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const step of adjacency.get(current) ?? []) {
      if (visited.has(step.next)) continue;
      visited.add(step.next);
      previous.set(step.next, { nodeId: current, edgeId: step.edgeId });
      if (step.next === endId) return buildPathIds(previous, startId, endId);
      queue.push(step.next);
    }
  }
  return undefined;
}

function buildPathIds(previous: Map<string, { nodeId: string; edgeId: string }>, startId: string, endId: string): Set<string> {
  const ids = new Set<string>([endId]);
  let current = endId;
  while (current !== startId) {
    const step = previous.get(current);
    if (!step) break;
    ids.add(step.edgeId);
    ids.add(step.nodeId);
    current = step.nodeId;
  }
  return ids;
}

function readMiniMapState(cy: Core): MiniMapState | undefined {
  const nodes = cy.nodes();
  if (!nodes.length) return undefined;
  const bounds = nodes.boundingBox();
  const zoom = cy.zoom();
  const pan = cy.pan();
  return {
    nodes: nodes.map((node) => ({ id: node.id(), kind: node.data("kind") as string, ...node.position() })),
    bounds: { x1: bounds.x1, y1: bounds.y1, w: Math.max(1, bounds.w), h: Math.max(1, bounds.h) },
    viewport: {
      x1: -pan.x / zoom,
      y1: -pan.y / zoom,
      w: cy.width() / zoom,
      h: cy.height() / zoom
    }
  };
}

function reportOptionLabel(run: CatalogRun, latest: boolean): string {
  const parts = [formatRunDate(run), run.runId];
  if (latest) parts.unshift("(latest)");
  if (run.parseErrorCount) parts.push(`${run.parseErrorCount} parse errors`);
  return parts.join(" - ");
}

function formatRunDate(run: CatalogRun): string {
  const date = parseReportDate(run.generatedAt) ?? parseRunIdDate(run.runId);
  if (!date) return run.runId;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function parseReportDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseRunIdDate(runId: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(runId);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
}

function IssueRow({ item }: { item: ReportItem }) {
  return (
    <article className="issue-row">
      <div className="issue-title">
        <code>{formatIssueDisplayRef(item)}</code>
        <span>{item.refKind}</span>
      </div>
      <p>{item.description}</p>
      <dl>
        <div><dt>Source</dt><dd>{item.sourceObject}:{item.sourceVerbName ?? item.sourceVerbId}</dd></div>
        <div><dt>Location</dt><dd>{item.sourcePath ? `${item.sourcePath}:${item.line}:${item.column}` : "no source path"}</dd></div>
        <div><dt>Reason</dt><dd>{item.reason}</dd></div>
        {item.issue.guardText ? <div><dt>Guard</dt><dd>{item.issue.guardText}</dd></div> : null}
        {item.issue.inlineErrorCodes?.length ? <div><dt>Inline</dt><dd>{item.issue.inlineErrorCodes.join(", ")}</dd></div> : null}
        {item.issue.permissions ? <div><dt>Permissions</dt><dd>{item.issue.permissions.join(", ") || "none"}</dd></div> : null}
        {item.issue.argumentSpecs ? <div><dt>Args</dt><dd>{item.issue.argumentSpecs.join(" ")}</dd></div> : null}
        {item.issue.callerCount !== undefined ? <div><dt>Callers</dt><dd>{item.issue.callerCount}</dd></div> : null}
        {item.issue.cyclomaticComplexity !== undefined ? <div><dt>Complexity</dt><dd>{item.issue.cyclomaticComplexity}</dd></div> : null}
        {item.issue.nonBlankLineCount !== undefined ? <div><dt>Lines</dt><dd>{item.issue.nonBlankLineCount}</dd></div> : null}
        {item.issue.maxControlFlowDepth !== undefined ? <div><dt>Nesting</dt><dd>{item.issue.maxControlFlowDepth}</dd></div> : null}
        {item.issue.statementCount !== undefined ? <div><dt>Statements</dt><dd>{item.issue.statementCount}</dd></div> : null}
        {item.issue.variableName ? <div><dt>Variable</dt><dd>{item.issue.variableName}</dd></div> : null}
        {item.issue.bindingKind ? <div><dt>Binding</dt><dd>{item.issue.bindingKind}</dd></div> : null}
        {item.issue.count !== undefined ? <div><dt>Count</dt><dd>{item.issue.count}</dd></div> : null}
        {item.issue.distinctCount !== undefined ? <div><dt>Distinct</dt><dd>{item.issue.distinctCount}</dd></div> : null}
        {item.issue.detail ? <div><dt>Detail</dt><dd>{item.issue.detail}</dd></div> : null}
        {item.issue.dbShape ? <div><dt>DB shape</dt><dd>{item.issue.dbShape}</dd></div> : null}
        {item.issue.rhsShape ? <div><dt>RHS shape</dt><dd>{item.issue.rhsShape}</dd></div> : null}
        {item.issue.rightText ? <div><dt>RHS</dt><dd>{item.issue.rightText}</dd></div> : null}
        {item.issue.effectiveValuePreview ? <div><dt>Current value</dt><dd>{item.issue.effectiveValuePreview}</dd></div> : null}
        {item.issue.effectiveValueObject ? <div><dt>Effective value</dt><dd>{item.issue.effectiveValueObject} ({item.issue.effectiveValueSource})</dd></div> : null}
        {item.issue.relatedSourceVerbId ? <div><dt>Related</dt><dd>{item.issue.relatedSourceObject}:{item.issue.relatedSourceVerbName ?? item.issue.relatedSourceVerbId}</dd></div> : null}
      </dl>
      {item.issue.sourceSnippet ? (
        <pre>
          {item.issue.sourceSnippet.lines.map((line) => (
            <div key={line.line} className={line.highlight ? "hit" : ""}>
              <span>{line.line + 1}</span>
              <code>{line.text}</code>
            </div>
          ))}
        </pre>
      ) : null}
    </article>
  );
}

function formatIssueDisplayRef(item: ReportItem): string {
  const verbNumber = verbNumberFromId(item.sourceVerbId);
  const source = item.sourceVerbName ? `${item.sourceObject}:${item.sourceVerbName}${verbNumber ? ` (${verbNumber})` : ""}` : item.sourceVerbId;
  const suffix = trailingRefDetail(item.ref, item.sourceVerbId, item.sourceObject, item.sourceVerbName);
  return suffix ? `${source} ${suffix}` : source;
}

function verbNumberFromId(sourceVerbId: string): string {
  return /^#[0-9]+:([0-9]+)$/.exec(sourceVerbId)?.[1] ?? "";
}

function trailingRefDetail(ref: string, sourceVerbId: string, sourceObject: string, sourceVerbName?: string): string {
  const tokens = ref.trim().split(/\s+/);
  if (tokens[0] === sourceVerbId) tokens.shift();
  if (sourceVerbName && tokens[0] === `${sourceObject}:${sourceVerbName}`) tokens.shift();
  return tokens.join(" ");
}

function stripGraphPrefix(value: string): string {
  return value.startsWith("verb:") ? value.slice("verb:".length) : value;
}

async function loadJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new ApiError(response.status, await response.text());
  return (await response.json()) as T;
}

async function postJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { method: "POST" });
  const body = await response.text();
  if (!response.ok) throw new ApiError(response.status, body);
  return JSON.parse(body) as T;
}

class ApiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(body);
  }
}

function parseJsonBody<T>(body: string): T | undefined {
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    const parsed = parseJsonBody<{ error?: string }>(cause.body);
    return parsed?.error ?? cause.body;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function existingJobFromConflict(cause: unknown): ReportJob | undefined {
  if (!(cause instanceof ApiError) || cause.status !== 409) return undefined;
  return parseJsonBody<ReportJob>(cause.body);
}

async function postReportJob(path: string): Promise<ReportJob> {
  try {
    return await postJson<ReportJob>(path);
  } catch (cause) {
    const existing = existingJobFromConflict(cause);
    if (existing) return existing;
    throw cause;
  }
}

function labelWorkspace(workspace: WorkspaceKey): string {
  if (workspace === "code_bugs") return "Code Bugs";
  if (workspace === "handled_expected") return "Handled / Expected";
  if (workspace === "dead_code") return "Dead Code";
  if (workspace === "code_insights") return "Code Improvements";
  if (workspace === "mutation_invariants") return "Mutation / Invariants";
  return "Dynamic Resolution";
}

createRoot(document.getElementById("root")!).render(<App />);
