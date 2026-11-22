import { classify } from "./triage.js";
import type { TestResult } from "./types.js";

export interface BugInput { result: TestResult; environment?: string; build?: string; evidence?: string[]; reproSteps?: string[] }

/** Drafts a bug report a developer can act on. It never invents steps: unknowns are left as explicit TODOs. */
export function draftBugReport(input: BugInput): string {
  const { result, environment, build, evidence = [], reproSteps = [] } = input;
  const c = classify(result.error);
  const severity = c.category === "auth" || c.category === "server-error" ? "High" : c.category === "assertion" || c.category === "contract" ? "Medium" : "To triage";
  const firstLine = (result.error ?? "").split("\n").find((l) => l.trim()) ?? "Test failed";
  return [
    `# [${result.area}] ${result.title}: ${firstLine.slice(0, 90)}`,
    "",
    `**Severity (suggested):** ${severity} · **Category:** ${c.category}${result.status === "flaky" ? " · **Flaky** (passed on retry)" : ""}`,
    `**Environment:** ${environment ?? "TODO"} · **Build:** ${build ?? "TODO"}`,
    `**Test:** \`${result.id}\``,
    "",
    "## Steps to reproduce",
    ...(reproSteps.length ? reproSteps.map((s, i) => `${i + 1}. ${s}`) : ["1. TODO: confirm the manual steps (the automated test name is above)"]),
    "",
    "## Expected",
    "TODO: the behaviour the requirement or test expects.",
    "",
    "## Actual",
    "```",
    (result.error ?? "(no error message captured)").slice(0, 1500),
    "```",
    "",
    "## Evidence",
    ...(evidence.length ? evidence.map((e) => `- ${e}`) : ["- TODO: attach trace, screenshot or request/response"]),
    "",
    "## Triage notes",
    `- Likely cause: ${c.likelyCause}`,
    `- Suggested next step: ${c.nextStep}`,
  ].join("\n");
}
