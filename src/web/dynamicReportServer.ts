import { existsSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { readReportItems, readReportsCatalog, readReportSummary, rerunLatestExtractReport, type RunReportResult } from "./reportStore.js";
import { buildNeighborhoodGraph, buildOverviewGraph, buildSourceVerbGraph, searchReportGraph } from "./graphProjection.js";

export interface ServeReportsOptions {
  reportsDir: string;
  host?: string;
  port?: number;
  appDir?: string;
  configPath?: string;
}

export interface ServedReportsApp {
  server: HttpServer;
  url: string;
  host: string;
  port: number;
  reportsDir: string;
  close: () => Promise<void>;
}

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8787;
const reportJobs = new Map<string, ReportJob>();

interface ReportJob {
  id: string;
  dbName: string;
  status: "running" | "complete" | "failed";
  phase: string;
  message?: string;
  startedAt: string;
  finishedAt?: string;
  result?: Pick<RunReportResult, "dbName" | "runId" | "runDir" | "reportDir">;
  error?: string;
}

export function createReportsApp(options: { reportsDir: string; appDir?: string; configPath?: string }): Express {
  const reportsDir = resolve(options.reportsDir);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  app.get("/api/catalog", async (_request, response) => {
    await sendJson(response, async () => readReportsCatalog(reportsDir));
  });

  app.get("/api/reports/:db/:run/summary", async (request, response) => {
    await sendJson(response, async () => readReportSummary(reportsDir, request.params.db!, request.params.run!));
  });

  app.get("/api/reports/:db/:run/items", async (request, response) => {
    await sendJson(response, async () =>
      readReportItems(reportsDir, request.params.db!, request.params.run!, {
        workspace: stringQuery(request, "workspace"),
        bucket: stringQuery(request, "bucket"),
        reason: stringQuery(request, "reason"),
        q: stringQuery(request, "q"),
        offset: numberQuery(request, "offset"),
        limit: numberQuery(request, "limit")
      })
    );
  });

  app.get("/api/reports/:db/:run/graph/search", async (request, response) => {
    await sendJson(response, async () => searchReportGraph(reportsDir, request.params.db!, request.params.run!, stringQuery(request, "q") ?? ""));
  });

  app.get("/api/reports/:db/:run/graph/source-verb/:sourceVerbId", async (request, response) => {
    await sendJson(response, async () =>
      buildSourceVerbGraph(reportsDir, request.params.db!, request.params.run!, request.params.sourceVerbId!, numberQuery(request, "limit"))
    );
  });

  app.get("/api/reports/:db/:run/graph/neighborhood", async (request, response) => {
    await sendJson(response, async () =>
      buildNeighborhoodGraph(
        reportsDir,
        request.params.db!,
        request.params.run!,
        stringQuery(request, "seed") ?? "",
        numberQuery(request, "depth") ?? 1,
        numberQuery(request, "limit")
      )
    );
  });

  app.get("/api/reports/:db/:run/graph/overview", async (request, response) => {
    const mode = stringQuery(request, "mode") === "object" ? "object" : "call";
    await sendJson(response, async () => buildOverviewGraph(reportsDir, request.params.db!, request.params.run!, mode, numberQuery(request, "limit")));
  });

  app.post("/api/reports/:db/regenerate-from-latest-extract", async (request, response) => {
    const dbName = request.params.db!;
    const running = [...reportJobs.values()].find((candidate) => candidate.dbName === dbName && candidate.status === "running");
    if (running) {
      response.status(409).json(running);
      return;
    }
    const job = createReportJob(dbName);
    reportJobs.set(job.id, job);
    void rerunLatestExtractReport({
      reportsDir,
      dbName,
      configPath: options.configPath,
      quiet: true,
      pretty: true,
      onProgress: (event) => {
        job.phase = event.phase;
        if (event.message) job.message = event.message;
      }
    })
      .then((result) => {
        job.status = "complete";
        job.phase = "done";
        job.finishedAt = new Date().toISOString();
        job.result = {
          dbName: result.dbName,
          runId: result.runId,
          runDir: result.runDir,
          reportDir: result.reportDir
        };
      })
      .catch((cause) => {
        job.status = "failed";
        job.phase = "failed";
        job.finishedAt = new Date().toISOString();
        job.error = cause instanceof Error ? cause.message : String(cause);
      });
    response.status(202).json(job);
  });

  app.get("/api/jobs/:id", (request, response) => {
    const job = reportJobs.get(request.params.id!);
    if (!job) {
      response.status(404).json({ error: `Unknown job ${request.params.id}` });
      return;
    }
    response.json(job);
  });

  app.get("/healthz", (_request, response) => {
    response.json({ ok: true, reportsDir });
  });

  const appDir = options.appDir ?? defaultAppDir();
  if (existsSync(appDir)) {
    app.use(express.static(appDir, { index: false }));
    app.use((_request, response) => {
      response.sendFile(join(appDir, "index.html"));
    });
  } else {
    app.get("/", (_request, response) => {
      response
        .status(200)
        .type("text/plain")
        .send("Dynamic report API is running, but the React app has not been built. Run npm run build.\n");
    });
  }

  return app;
}

function createReportJob(dbName: string): ReportJob {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    dbName,
    status: "running",
    phase: "queued",
    startedAt: new Date().toISOString()
  };
}

export async function serveReportsApp(options: ServeReportsOptions): Promise<ServedReportsApp> {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const reportsDir = resolve(options.reportsDir);
  const app = createReportsApp({ reportsDir, ...(options.appDir ? { appDir: options.appDir } : {}), ...(options.configPath ? { configPath: options.configPath } : {}) });

  const server = await new Promise<HttpServer>((resolveServer, reject) => {
    const pending = app.listen(requestedPort, host);
    pending.once("error", reject);
    pending.once("listening", () => {
      pending.off("error", reject);
      resolveServer(pending);
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : requestedPort;
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  return {
    server,
    host,
    port: actualPort,
    url: `http://${displayHost}:${actualPort}/`,
    reportsDir,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      })
  };
}

async function sendJson(response: Response, build: () => Promise<unknown>): Promise<void> {
  try {
    response.json(await build());
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const missing = message.includes("ENOENT");
    response.status(missing ? 404 : 500).json({ error: message });
  }
}

function stringQuery(request: Request, key: string): string | undefined {
  const value = request.query[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberQuery(request: Request, key: string): number | undefined {
  const value = stringQuery(request, key);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function defaultAppDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "..", "..", "web-app");
}
