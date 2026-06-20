import { Command } from "commander";
import { runReportPipeline } from "./web/reportStore.js";
import { serveReportsApp } from "./web/dynamicReportServer.js";
import { loadReportConfig } from "./report/reportConfig.js";
import {
  formatCoverageReport,
  formatCallerQuery,
  formatReceiverExplanation,
  formatRefQuery,
  formatSourceVerbQuery,
  formatIssueContext,
  formatIssuesReport,
  formatMutationInvariantsReport,
  formatCodeInsightsReport,
  formatUnprogrammedVerbsReport,
  formatUnusedVerbsReport,
  formatUnresolvedReport,
  formatVerbContext,
  contextForIssue,
  contextForVerb,
  explainReceiver,
  indexMooCodeGraph,
  inspectExtractDir,
  queryCallers,
  queryRefs,
  querySourceVerb,
  reportIssues,
  reportMutationInvariants,
  reportCodeInsights,
  reportUnprogrammedVerbs,
  reportUnusedVerbs,
  reportCoverage,
  reportUnresolved,
  resolveMooCodeGraph,
  serveIssueWebReport,
  validateExtractDir
} from "./index.js";
import type { IssueBucket, IssueDomain } from "./report/reportIssues.js";

const program = new Command();

program.name("moo-code-graph").description("Extract raw MOO code facts from ToastStunt extractor output.").version("0.1.0");

program
  .command("run-report")
  .argument("<db-path>")
  .option("--db-name <name>", "Report database name; defaults to the DB file stem")
  .option("--reports-dir <dir>", "Persistent reports directory", "reports")
  .option("--config <path>", "Report configuration YAML path; defaults to ./moo-code-graph.yaml")
  .option("--overwrite", "Allow replacing an existing timestamped run dir")
  .option("--pretty", "Pretty-print JSON where applicable")
  .option("--quiet", "Suppress progress logs")
  .action(
    async (
      dbPath: string,
      options: { dbName?: string; reportsDir: string; config?: string; overwrite?: boolean; pretty?: boolean; quiet?: boolean }
    ) => {
      const result = await runReportPipeline({
        dbPath,
        dbName: options.dbName,
        reportsDir: options.reportsDir,
        configPath: options.config,
        overwrite: Boolean(options.overwrite),
        pretty: Boolean(options.pretty),
        quiet: Boolean(options.quiet),
        onProgress: options.quiet ? undefined : (event) => console.error(`${event.phase}${event.message ? `: ${event.message}` : ""}`)
      });
      if (!options.quiet) console.log(JSON.stringify(result, null, 2));
    }
  );

program
  .command("index")
  .argument("<extract-dir>")
  .requiredOption("--out <dir>", "Output directory")
  .option("--overwrite", "Allow replacing output dir")
  .option("--pretty", "Pretty-print JSON where applicable")
  .option("--quiet", "Suppress progress logs")
  .action(async (extractDir: string, options: { out: string; overwrite?: boolean; pretty?: boolean; quiet?: boolean }) => {
    const result = await indexMooCodeGraph({
      extractDir,
      outputDir: options.out,
      overwrite: Boolean(options.overwrite),
      pretty: Boolean(options.pretty),
      quiet: Boolean(options.quiet),
      onProgress: options.quiet ? undefined : (event) => console.error(`${event.phase}${event.message ? `: ${event.message}` : ""}`)
    });
    if (!options.quiet) console.log(JSON.stringify(result, null, 2));
  });

program
  .command("inspect")
  .argument("<extract-dir>")
  .action(async (extractDir: string) => {
    console.log(JSON.stringify(await inspectExtractDir(extractDir), null, 2));
  });

program
  .command("validate")
  .argument("<extract-dir>")
  .action(async (extractDir: string) => {
    const result = await validateExtractDir(extractDir);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.valid ? 0 : 1;
  });

program
  .command("resolve")
  .argument("<graph-dir>")
  .requiredOption("--extract <dir>", "Extractor output directory")
  .requiredOption("--out <dir>", "Output directory")
  .option("--overwrite", "Allow replacing output dir")
  .option("--pretty", "Pretty-print JSON where applicable")
  .option("--quiet", "Suppress progress logs")
  .action(async (graphDir: string, options: { extract: string; out: string; overwrite?: boolean; pretty?: boolean; quiet?: boolean }) => {
    const result = await resolveMooCodeGraph({
      graphDir,
      extractDir: options.extract,
      outputDir: options.out,
      overwrite: Boolean(options.overwrite),
      pretty: Boolean(options.pretty),
      quiet: Boolean(options.quiet),
      onProgress: options.quiet ? undefined : (event) => console.error(`${event.phase}${event.message ? `: ${event.message}` : ""}`)
    });
    if (!options.quiet) console.log(JSON.stringify(result, null, 2));
  });

const reportCommand = program.command("report").description("Print human-readable reports from generated graph outputs.");

reportCommand
  .command("coverage")
  .argument("<resolved-dir>")
  .option("--json", "Emit JSON instead of text")
  .action(async (resolvedDir: string, options: { json?: boolean }) => {
    const report = await reportCoverage({ resolvedDir });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    process.stdout.write(formatCoverageReport(report));
  });

reportCommand
  .command("issues")
  .argument("<resolved-dir>")
  .option("--json", "Emit JSON instead of text")
  .option("--examples <count>", "Maximum findings to print per bucket", parsePositiveInteger)
  .option("--domain <domain>", "Issue domain: moo_bug, handled_inline, graph_refinement (Dynamic Resolution)")
  .option("--bucket <bucket>", "Issue bucket, such as missing_verb, invalid_property_reference, or guarded_runtime_property")
  .option("--reason <reason>", "Exact issue reason, such as no_matching_property")
  .action(
    async (
      resolvedDir: string,
      options: { json?: boolean; examples?: number; domain?: string; bucket?: string; reason?: string }
    ) => {
    const report = await reportIssues({
      resolvedDir,
      examplesPerBucket: options.examples,
      ...(options.domain ? { domain: options.domain as IssueDomain } : {}),
      ...(options.bucket ? { bucket: options.bucket as IssueBucket } : {}),
      ...(options.reason ? { reason: options.reason } : {})
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    process.stdout.write(formatIssuesReport(report));
  });

reportCommand
  .command("unused-verbs")
  .argument("<resolved-dir>")
  .option("--extract <dir>", "Extractor output directory; defaults to resolved manifest sourceExtractDir")
  .option("--json", "Emit JSON instead of text")
  .option("--examples <count>", "Maximum findings to print per bucket", parsePositiveInteger)
  .option("--all-programmed", "Consider all programmed verbs instead of only this-none-this programmatic verbs")
  .option("--require-execute", "Only include +x verbs in the target set")
  .action(
    async (
      resolvedDir: string,
      options: { extract?: string; json?: boolean; examples?: number; allProgrammed?: boolean; requireExecute?: boolean }
    ) => {
      const report = await reportUnusedVerbs({
        resolvedDir,
        ...(options.extract ? { extractDir: options.extract } : {}),
        examplesPerBucket: options.examples,
        programmaticOnly: !options.allProgrammed,
        requireExecute: Boolean(options.requireExecute)
      });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      process.stdout.write(formatUnusedVerbsReport(report));
    }
  );

reportCommand
  .command("unprogrammed-verbs")
  .argument("<resolved-dir>")
  .option("--extract <dir>", "Extractor output directory; defaults to resolved manifest sourceExtractDir")
  .option("--json", "Emit JSON instead of text")
  .option("--examples <count>", "Maximum findings to print per bucket", parsePositiveInteger)
  .action(async (resolvedDir: string, options: { extract?: string; json?: boolean; examples?: number }) => {
    const report = await reportUnprogrammedVerbs({
      resolvedDir,
      ...(options.extract ? { extractDir: options.extract } : {}),
      examplesPerBucket: options.examples
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    process.stdout.write(formatUnprogrammedVerbsReport(report));
  });

reportCommand
  .command("code-insights")
  .argument("<resolved-dir>")
  .option("--json", "Emit JSON instead of text")
  .option("--config <path>", "Report configuration YAML path; defaults to ./moo-code-graph.yaml")
  .option("--examples <count>", "Maximum findings to print per bucket", parsePositiveInteger)
  .option("--min-complexity <count>", "Minimum cyclomatic complexity to include", parsePositiveInteger)
  .option("--min-lines <count>", "Minimum non-blank source lines to include", parsePositiveInteger)
  .option("--min-nesting <count>", "Minimum control-flow nesting depth to include", parsePositiveInteger)
  .action(
    async (
      resolvedDir: string,
      options: { json?: boolean; config?: string; examples?: number; minComplexity?: number; minLines?: number; minNesting?: number }
    ) => {
      const loadedConfig = await loadReportConfig(options.config);
      const report = await reportCodeInsights({
        resolvedDir,
        examplesPerBucket: options.examples,
        config: loadedConfig.config.reports.codeInsights,
        minComplexity: options.minComplexity,
        minLines: options.minLines,
        minNesting: options.minNesting
      });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      process.stdout.write(formatCodeInsightsReport(report));
    }
  );

reportCommand
  .command("mutation-invariants")
  .argument("<resolved-dir>")
  .option("--json", "Emit JSON instead of text")
  .option("--config <path>", "Report configuration YAML path; defaults to ./moo-code-graph.yaml")
  .option("--examples <count>", "Maximum findings to print per bucket", parsePositiveInteger)
  .action(async (resolvedDir: string, options: { json?: boolean; config?: string; examples?: number }) => {
    const loadedConfig = await loadReportConfig(options.config);
    const report = await reportMutationInvariants({
      resolvedDir,
      examplesPerBucket: options.examples,
      config: loadedConfig.config.reports.mutationInvariants
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    process.stdout.write(formatMutationInvariantsReport(report));
  });

const serveCommand = program.command("serve").description("Serve local web reports for generated graph outputs.");

serveCommand
  .command("report")
  .argument("<resolved-dir>")
  .option("--host <host>", "Host/interface to bind", "0.0.0.0")
  .option("--port <port>", "Port to listen on", parseNonNegativeInteger, 8787)
  .option("--config <path>", "Report configuration YAML path; defaults to ./moo-code-graph.yaml")
  .option("--context-lines <count>", "Source context lines around each issue", parseNonNegativeInteger)
  .option("--examples-per-reason <count>", "Maximum issue cards to render per reason", parsePositiveInteger)
  .option("--max-issues <count>", "Maximum issue cards to render overall", parsePositiveInteger)
  .action(
    async (
      resolvedDir: string,
      options: { host: string; port: number; config?: string; contextLines?: number; examplesPerReason?: number; maxIssues?: number }
    ) => {
      const loadedConfig = await loadReportConfig(options.config);
      const served = await serveIssueWebReport({
        resolvedDir,
        host: options.host,
        port: options.port,
        config: loadedConfig.config,
        contextLines: options.contextLines,
        examplesPerReason: options.examplesPerReason,
        maxIssues: options.maxIssues
      });
      console.log(`Serving MOO code graph issue report at ${served.url}`);
      console.log(`Resolved dir: ${resolvedDir}`);
      console.log("Press Ctrl+C to stop.");
      const shutdown = async (): Promise<void> => {
        await served.close();
        process.exit(0);
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    }
  );

serveCommand
  .command("reports")
  .argument("<reports-dir>")
  .option("--host <host>", "Host/interface to bind", "0.0.0.0")
  .option("--port <port>", "Port to listen on", parseNonNegativeInteger, 8787)
  .option("--config <path>", "Report configuration YAML path; defaults to ./moo-code-graph.yaml")
  .action(async (reportsDir: string, options: { host: string; port: number; config?: string }) => {
    const served = await serveReportsApp({
      reportsDir,
      host: options.host,
      port: options.port,
      configPath: options.config
    });
    console.log(`Serving MOO code graph reports at ${served.url}`);
    console.log(`Reports dir: ${served.reportsDir}`);
    console.log("Press Ctrl+C to stop.");
    const shutdown = async (): Promise<void> => {
      await served.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  });

const explainCommand = program.command("explain").description("Explain resolved graph rows for a source location or unresolved set.");

explainCommand
  .command("receiver")
  .argument("<resolved-dir>")
  .requiredOption("--source <path>", "Source path inside extractor output")
  .requiredOption("--line <line>", "Zero-based source line", parseNonNegativeInteger)
  .option("--column <column>", "Zero-based source column", parseNonNegativeInteger)
  .option("--json", "Emit JSON instead of text")
  .action(async (resolvedDir: string, options: { source: string; line: number; column?: number; json?: boolean }) => {
    const explanation = await explainReceiver({
      resolvedDir,
      sourcePath: options.source,
      line: options.line,
      ...(options.column !== undefined ? { column: options.column } : {})
    });
    if (options.json) {
      console.log(JSON.stringify(explanation, null, 2));
      return;
    }
    process.stdout.write(formatReceiverExplanation(explanation));
  });

explainCommand
  .command("unresolved")
  .argument("<resolved-dir>")
  .option("--json", "Emit JSON instead of text")
  .option("--top <count>", "Maximum source-verb groups to print", parsePositiveInteger)
  .option("--examples <count>", "Maximum findings to print per source-verb group", parsePositiveInteger)
  .action(async (resolvedDir: string, options: { json?: boolean; top?: number; examples?: number }) => {
    const report = await reportUnresolved({ resolvedDir, top: options.top, examplesPerGroup: options.examples });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    process.stdout.write(formatUnresolvedReport(report));
  });

const queryCommand = program.command("query").description("Query resolved graph rows.");

queryCommand
  .command("callers")
  .argument("<resolved-dir>")
  .requiredOption("--target-verb <id>", "Target verb id, for example #30:1")
  .option("--json", "Emit JSON instead of text")
  .action(async (resolvedDir: string, options: { targetVerb: string; json?: boolean }) => {
    const result = await queryCallers({ resolvedDir, targetVerbId: options.targetVerb });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    process.stdout.write(formatCallerQuery(result));
  });

const contextCommand = program.command("context").description("Build compact context bundles from resolved graph rows.");

contextCommand
  .command("verb")
  .argument("<resolved-dir>")
  .argument("<source-verb-id>")
  .option("--json", "Emit JSON instead of text")
  .action(async (resolvedDir: string, sourceVerbId: string, options: { json?: boolean }) => {
    const bundle = await contextForVerb({ resolvedDir, sourceVerbId });
    if (options.json) {
      console.log(JSON.stringify(bundle, null, 2));
      return;
    }
    process.stdout.write(formatVerbContext(bundle));
  });

contextCommand
  .command("issue")
  .argument("<resolved-dir>")
  .requiredOption("--ref <ref>", "Issue ref to bundle, such as $cu:suspend_if_needed or this.missing")
  .option("--context-lines <count>", "Source context lines around each issue", parseNonNegativeInteger)
  .option("--json", "Emit JSON instead of text")
  .action(async (resolvedDir: string, options: { ref: string; contextLines?: number; json?: boolean }) => {
    const bundle = await contextForIssue({ resolvedDir, ref: options.ref, contextLines: options.contextLines });
    if (options.json) {
      console.log(JSON.stringify(bundle, null, 2));
      return;
    }
    process.stdout.write(formatIssueContext(bundle));
  });

queryCommand
  .command("refs")
  .argument("<resolved-dir>")
  .option("--object <ref>", "Object ref, for example #30")
  .option("--symbol <symbol>", "System object symbol, for example $string_utils")
  .option("--json", "Emit JSON instead of text")
  .action(async (resolvedDir: string, options: { object?: string; symbol?: string; json?: boolean }) => {
    const result = await queryRefs({ resolvedDir, object: options.object, symbol: options.symbol });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    process.stdout.write(formatRefQuery(result));
  });

queryCommand
  .command("source-verb")
  .argument("<resolved-dir>")
  .argument("<source-verb-id>")
  .option("--json", "Emit JSON instead of text")
  .action(async (resolvedDir: string, sourceVerbId: string, options: { json?: boolean }) => {
    const result = await querySourceVerb({ resolvedDir, sourceVerbId });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    process.stdout.write(formatSourceVerbQuery(result));
  });

reportCommand
  .command("unresolved")
  .argument("<resolved-dir>")
  .option("--json", "Emit JSON instead of text")
  .option("--top <count>", "Maximum source-verb groups to print", parsePositiveInteger)
  .option("--examples <count>", "Maximum findings to print per source-verb group", parsePositiveInteger)
  .action(async (resolvedDir: string, options: { json?: boolean; top?: number; examples?: number }) => {
    const report = await reportUnresolved({ resolvedDir, top: options.top, examplesPerGroup: options.examples });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    process.stdout.write(formatUnresolvedReport(report));
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a nonnegative integer, got ${value}`);
  }
  return parsed;
}
