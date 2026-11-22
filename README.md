# qa-mcp-server

[![CI](https://github.com/fauzanfzn/qa-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/fauzanfzn/qa-mcp-server/actions/workflows/ci.yml)

An **MCP (Model Context Protocol) server that gives AI assistants real QA tools.** Connect it to Claude Desktop, Claude Code or Cursor and ask things like:

> *"Run the checkout tests, tell me if we can release, and draft bug reports for anything that's a real defect."*

The assistant then calls tools that run your suite, read the report, group failures by root cause, score readiness per feature area, track flaky tests across runs and draft bug reports. The tools do the deterministic work; the model does the reasoning and the conversation.

It reads **Playwright JSON** and **JUnit XML** (Maven Surefire, Gradle, pytest, Jest-junit…), so it works with most stacks.

## Tools

| Tool | What it returns |
| --- | --- |
| `run_tests` | Runs an allow-listed test command (no shell), then readiness + triage of the report it wrote |
| `parse_report` | Totals plus every failed/flaky test with its error |
| `triage_failures` | Failures grouped by normalised error signature, classified as assertion, timeout, locator, network, server-error, auth, contract or test-data, each with a likely cause and next step |
| `readiness_score` | Readiness % per feature area (flaky counts as half a pass) and a READY / AT RISK / NOT READY verdict; critical areas block release |
| `record_run` / `flaky_tests` | Stores outcomes across runs and ranks tests by how often they flip between pass and fail |
| `draft_bug_report` | A bug report for one failure; unknown details are left as `TODO` instead of invented |

Resource: `qa://history/flaky` (JSON).

## Example (real output from the bundled fixture)

`readiness_score` with `criticalAreas: ["checkout"]`:

```
## Release readiness: 43.8% — NOT READY

| Area     | Readiness | Passed | Failed | Flaky | Skipped |
| ❌ api      | 33.3% | 1 | 2 | 0 | 0 |
| ❌ checkout | 50%   | 1 | 1 | 1 | 0 |
| ❌ auth     | 50%   | 1 | 1 | 0 | 1 |

Blockers
- checkout: [chromium] shows error for declined card
```

`triage_failures` turns 5 failures into 4 groups, so the two `503 Service Unavailable` errors become one environment issue instead of two bug tickets:

```
### 1. server-error — 2 test(s)
- Likely cause: Backend error or unhealthy environment, not the test.
- Next step: Check service logs and environment health; retry once before filing a product bug.
### 2. assertion — 1 test(s)   Expected "Card declined", received "Something went wrong"
### 3. timeout — 1 test(s)     applies voucher (flaky)
### 4. locator — 1 test(s)     locator.click timeout on getByTestId('login-button')
```

The CI job runs the same demo through a real MCP client and posts the output to the job summary.

## Setup

```bash
git clone https://github.com/fauzanfzn/qa-mcp-server && cd qa-mcp-server
npm ci && npm run build
```

**Claude Code**

```bash
claude mcp add qa -e QA_MCP_ROOT=/path/to/your/project -- node /path/to/qa-mcp-server/dist/index.js
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "qa": {
      "command": "node",
      "args": ["/path/to/qa-mcp-server/dist/index.js"],
      "env": { "QA_MCP_ROOT": "/path/to/your/project" }
    }
  }
}
```

For Playwright, add the JSON reporter, e.g. `reporter: [['json', { outputFile: 'results.json' }]]`.

## Safety by design

An AI client should get useful tools, not a shell.

- **No shell, allow-listed binaries only.** `run_tests` spawns the command with an argument array, so nothing is interpolated. Allowed binaries come from `QA_MCP_ALLOWED_COMMANDS` (default `npx,npm,pnpm,yarn,mvn,gradle,pytest`).
- **Files stay inside the project.** Every path is resolved against `QA_MCP_ROOT`; `../../etc/passwd` is rejected (there is a test for it).
- **No invented facts.** Bug reports leave unknown steps and expected results as `TODO` for a human to confirm.

| Variable | Default |
| --- | --- |
| `QA_MCP_ROOT` | current directory |
| `QA_MCP_ALLOWED_COMMANDS` | `npx,npm,pnpm,yarn,mvn,gradle,pytest` |
| `QA_MCP_HISTORY` | `.qa-mcp/history.json` |
| `QA_MCP_TIMEOUT_MS` | `900000` (15 min) |

## Tests

```bash
npm test
```

15 tests: unit tests for parsers, triage rules, readiness and flaky history, plus end-to-end tests that start the server over stdio and call it with the official MCP client, exactly as Claude would. CI runs them on Node 20 and 22.

## Related

- [ai-qa-automation-framework](https://github.com/fauzanfzn/ai-qa-automation-framework): Playwright + TypeScript framework (UI, API contracts, visual, LLM evaluation)
- [java-api-test-framework](https://github.com/fauzanfzn/java-api-test-framework): Java + REST Assured + JUnit 5 + Allure
- Portfolio: [fauzanfzn.github.io](https://fauzanfzn.github.io)

---
Built by [Muhammad Nur Fauzan](https://www.linkedin.com/in/mnurfauzan-qa), QA Automation Engineer / SDET.
