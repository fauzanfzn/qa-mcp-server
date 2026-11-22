// Calls every tool on the bundled fixtures through a real MCP client and prints the answers.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const client = new Client({ name: "demo", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "dist/index.js")], stderr: "ignore" }));
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
  console.log(`\n<!-- ${name} ${JSON.stringify(args)} -->\n` + r.content[0].text + "\n");
};
await call("readiness_score", { path: "fixtures/playwright-report.json", criticalAreas: ["checkout"] });
await call("triage_failures", { path: "fixtures/playwright-report.json" });
await call("draft_bug_report", { path: "fixtures/playwright-report.json", test: "declined card", environment: "staging", build: "web 2.14.0" });
await client.close();
