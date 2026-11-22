import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { draftBugReport } from "./core/bugreport.js";
import { History } from "./core/history.js";
import { parseReport } from "./core/parsers.js";
import { readiness, readinessMarkdown } from "./core/readiness.js";
import { runCommand } from "./core/runner.js";
import { triage, triageMarkdown } from "./core/triage.js";

export interface Config { root: string; historyFile: string; allowedCommands: string[]; timeoutMs: number }

export function configFromEnv(env = process.env): Config {
  const root = resolve(env.QA_MCP_ROOT ?? process.cwd());
  return {
    root,
    historyFile: resolve(root, env.QA_MCP_HISTORY ?? ".qa-mcp/history.json"),
    allowedCommands: (env.QA_MCP_ALLOWED_COMMANDS ?? "npx,npm,pnpm,yarn,mvn,gradle,pytest").split(",").map((s) => s.trim()).filter(Boolean),
    timeoutMs: Number(env.QA_MCP_TIMEOUT_MS ?? 15 * 60 * 1000),
  };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function createServer(config: Config): McpServer {
  const server = new McpServer({ name: "qa-mcp-server", version: "1.0.0" });
  const history = new History(config.historyFile);

  /** Keeps every file access inside the project root, so a prompt cannot read arbitrary files. */
  const inRoot = (p: string) => {
    const full = resolve(config.root, p);
    const rel = relative(config.root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path "${p}" is outside the project root ${config.root}`);
    return full;
  };

  const reportPath = z.string().describe("Path to a Playwright JSON report or JUnit XML file, relative to the project root");

  server.registerTool("parse_report", {
    title: "Parse test report",
    description: "Read a Playwright JSON or JUnit XML report and return totals plus every failed or flaky test with its error.",
    inputSchema: { path: reportPath },
  }, async ({ path }) => {
    const run = parseReport(inRoot(path));
    const problems = run.results.filter((r) => r.status === "failed" || r.status === "flaky")
      .map((r) => ({ id: r.id, status: r.status, area: r.area, error: r.error?.slice(0, 400) }));
    return text(JSON.stringify({ total: run.total, passed: run.passed, failed: run.failed, flaky: run.flaky, skipped: run.skipped, durationMs: run.durationMs, problems }, null, 2));
  });

  server.registerTool("triage_failures", {
    title: "Triage failures",
    description: "Group failures by root-cause signature and classify each group (assertion, timeout, locator, network, server-error, auth, contract, test-data) with a likely cause and next step.",
    inputSchema: { path: reportPath },
  }, async ({ path }) => text(triageMarkdown(triage(parseReport(inRoot(path)).results))));

  server.registerTool("readiness_score", {
    title: "Release readiness score",
    description: "Score release readiness per feature area (flaky counts as half a pass) and give a READY / AT RISK / NOT READY verdict.",
    inputSchema: {
      path: reportPath,
      threshold: z.number().min(0).max(100).optional().describe("Overall % needed for READY (default 95)"),
      criticalAreas: z.array(z.string()).optional().describe("Areas where any failure blocks release, e.g. ['checkout','auth']"),
    },
  }, async ({ path, threshold, criticalAreas }) => text(readinessMarkdown(readiness(parseReport(inRoot(path)), { threshold, criticalAreas }))));

  server.registerTool("record_run", {
    title: "Record run in flaky history",
    description: "Store this report's outcomes in the local history so flakiness can be measured across runs.",
    inputSchema: { path: reportPath },
  }, async ({ path }) => {
    const n = history.record(parseReport(inRoot(path)));
    return text(`Recorded ${n} results in ${relative(config.root, config.historyFile)}.`);
  });

  server.registerTool("flaky_tests", {
    title: "List flaky tests",
    description: "List tests whose outcome flips between runs, ranked by flip rate, from the recorded history.",
    inputSchema: { minRuns: z.number().int().min(2).optional().describe("Ignore tests seen in fewer runs (default 3)") },
  }, async ({ minRuns }) => {
    const rows = history.flaky(minRuns ?? 3);
    if (!rows.length) return text("No flaky tests in the recorded history.");
    return text(["| Test | Runs | Flip rate | Non-pass rate | Last |", "| --- | ---: | ---: | ---: | --- |",
      ...rows.slice(0, 30).map((r) => `| ${r.id} | ${r.runs} | ${Math.round(r.flipRate * 100)}% | ${Math.round(r.failRate * 100)}% | ${r.lastStatus} |`)].join("\n"));
  });

  server.registerTool("draft_bug_report", {
    title: "Draft bug report",
    description: "Draft a bug report for one failed test. Unknown details are left as TODO instead of being invented.",
    inputSchema: {
      path: reportPath,
      test: z.string().describe("Part of the failing test's title or id"),
      environment: z.string().optional(),
      build: z.string().optional(),
      evidence: z.array(z.string()).optional().describe("Links or paths to trace, screenshot, logs"),
      reproSteps: z.array(z.string()).optional(),
    },
  }, async ({ path, test, ...rest }) => {
    const run = parseReport(inRoot(path));
    const matches = run.results.filter((r) => r.status !== "passed" && r.status !== "skipped" && (r.id + r.title).toLowerCase().includes(test.toLowerCase()));
    if (!matches.length) return text(`No failed or flaky test matches "${test}".`);
    if (matches.length > 1) return text(`"${test}" matches ${matches.length} tests; be more specific:\n` + matches.map((m) => `- ${m.id}`).join("\n"));
    return text(draftBugReport({ result: matches[0], ...rest }));
  });

  server.registerTool("run_tests", {
    title: "Run tests",
    description: "Run an allow-listed test command (no shell), then parse its report and return readiness plus failure triage.",
    inputSchema: {
      command: z.string().describe("Binary to run, e.g. 'npx' or 'mvn' (must be allow-listed)"),
      args: z.array(z.string()).describe("Arguments, e.g. ['playwright','test','--reporter=json'] "),
      reportPath: reportPath.describe("Report file the command writes, relative to the project root"),
      cwd: z.string().optional().describe("Working directory inside the project root"),
    },
  }, async ({ command, args, reportPath: rp, cwd }) => {
    const out = await runCommand(command, args, { cwd: inRoot(cwd ?? "."), timeoutMs: config.timeoutMs, allow: config.allowedCommands });
    let body: string;
    try {
      const run = parseReport(inRoot(rp));
      history.record(run);
      body = readinessMarkdown(readiness(run)) + "\n\n" + triageMarkdown(triage(run.results));
    } catch (e) {
      body = `Could not read the report: ${(e as Error).message}\n\nstdout (tail):\n${out.stdoutTail}\n\nstderr (tail):\n${out.stderrTail}`;
    }
    return text(`Exit code ${out.exitCode} in ${Math.round(out.durationMs / 1000)}s\n\n${body}`);
  });

  server.registerResource("flaky-history", "qa://history/flaky", {
    title: "Flaky test history",
    description: "Tests that flip between pass and fail across recorded runs (JSON)",
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(history.flaky(2), null, 2) }] }));

  return server;
}
