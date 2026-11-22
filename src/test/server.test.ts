import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** End-to-end: start the real server over stdio, exactly as Claude Desktop / Claude Code would. */
async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/index.js")],
    env: { ...process.env, QA_MCP_ROOT: process.cwd(), QA_MCP_HISTORY: join(mkdtempSync(join(tmpdir(), "qa-")), "h.json"), QA_MCP_ALLOWED_COMMANDS: "node" } as Record<string, string>,
    stderr: "ignore",
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0].text);

test("lists all QA tools", async () => {
  const client = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["draft_bug_report", "flaky_tests", "parse_report", "readiness_score", "record_run", "run_tests", "triage_failures"]);
  await client.close();
});

test("readiness_score and triage_failures work on a Playwright report", async () => {
  const client = await connect();
  const r = textOf(await client.callTool({ name: "readiness_score", arguments: { path: "fixtures/playwright-report.json", criticalAreas: ["checkout"] } }));
  assert.match(r, /Release readiness: 43\.8% — NOT READY/);
  assert.match(r, /checkout: \[chromium\] shows error for declined card/);
  const t = textOf(await client.callTool({ name: "triage_failures", arguments: { path: "fixtures/playwright-report.json" } }));
  assert.match(t, /5 failures in 4 groups/);
  assert.match(t, /server-error — 2 test\(s\)/);
  await client.close();
});

test("draft_bug_report asks for a narrower match when ambiguous", async () => {
  const client = await connect();
  const many = textOf(await client.callTool({ name: "draft_bug_report", arguments: { path: "fixtures/playwright-report.json", test: "orders" } }));
  assert.match(many, /matches 2 tests/);
  const one = textOf(await client.callTool({ name: "draft_bug_report", arguments: { path: "fixtures/junit-report.xml", test: "update_requires_token", build: "1.4.2" } }));
  assert.match(one, /^# \[BookingTest\] update_requires_token/);
  await client.close();
});

test("refuses paths outside the project root", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "parse_report", arguments: { path: "../../etc/passwd" } });
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(textOf(res), /outside the project root/);
  await client.close();
});

test("run_tests only runs allow-listed commands, without a shell", async () => {
  const client = await connect();
  const blocked = await client.callTool({ name: "run_tests", arguments: { command: "bash", args: ["-c", "echo hi"], reportPath: "fixtures/junit-report.xml" } });
  assert.equal((blocked as { isError?: boolean }).isError, true);
  assert.match(textOf(blocked), /not allowed/);
  const ok = textOf(await client.callTool({ name: "run_tests", arguments: { command: "node", args: ["-e", "process.exit(1)"], reportPath: "fixtures/junit-report.xml" } }));
  assert.match(ok, /Exit code 1/);
  assert.match(ok, /Release readiness: 50% — NOT READY/);
  await client.close();
});
