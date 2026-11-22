import type { TestResult } from "./types.js";

export type Category =
  | "assertion"
  | "timeout"
  | "locator"
  | "network"
  | "server-error"
  | "auth"
  | "contract"
  | "test-data"
  | "unknown";

interface Rule { category: Category; pattern: RegExp; likelyCause: string; nextStep: string }

// Order matters: the first matching rule wins, most specific first.
const RULES: Rule[] = [
  { category: "auth", pattern: /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid token|bad credentials/i,
    likelyCause: "Credentials, token or permissions changed or expired.",
    nextStep: "Check the test account and token setup; confirm whether the permission change is intended." },
  { category: "server-error", pattern: /\b(500|502|503|504)\b|internal server error|bad gateway|service unavailable/i,
    likelyCause: "Backend error or unhealthy environment, not the test.",
    nextStep: "Check service logs and environment health; retry once before filing a product bug." },
  { category: "contract", pattern: /schema|json ?schema|zod|required property|expected type|must have required|ZodError/i,
    likelyCause: "Response shape changed: a field was renamed, removed or changed type.",
    nextStep: "Diff the response against the contract; ask the API owner whether it is a breaking change." },
  { category: "network", pattern: /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|net::ERR_|connection refused|UnknownHost/i,
    likelyCause: "Environment unreachable or DNS/network problem.",
    nextStep: "Verify the base URL and that the environment is up; this is usually infrastructure, not a defect." },
  { category: "locator", pattern: /locator\.\w+:|selector|strict mode violation|waiting for (getBy|locator)|element (is )?not (visible|attached|found)|resolved to \d+ elements/i,
    likelyCause: "UI changed (selector, text or structure) or the element never rendered.",
    nextStep: "Open the trace/screenshot; prefer role- or data-test-based locators if the UI change is intended." },
  { category: "timeout", pattern: /timeout|timed out|exceeded/i,
    likelyCause: "Slow response, missing wait condition, or a step that never completes.",
    nextStep: "Check whether the app is slower than usual; replace fixed waits with web-first assertions." },
  { category: "test-data", pattern: /already exists|duplicate|not found.*(id|record)|404|no such (user|record)|stale/i,
    likelyCause: "Test data missing, reused or polluted by another run.",
    nextStep: "Generate unique data per test and clean up after; avoid depending on shared records." },
  { category: "assertion", pattern: /expect|expected|assert|toBe|toEqual|toHave|but was|to equal/i,
    likelyCause: "Behaviour differs from the expected result: a real defect or an outdated expectation.",
    nextStep: "Reproduce manually; if the new behaviour is correct update the test, otherwise file a bug." },
];

export interface Classified { category: Category; likelyCause: string; nextStep: string }

export function classify(error = ""): Classified {
  const rule = RULES.find((r) => r.pattern.test(error));
  return rule
    ? { category: rule.category, likelyCause: rule.likelyCause, nextStep: rule.nextStep }
    : { category: "unknown", likelyCause: "No known pattern matched.", nextStep: "Read the full error and trace." };
}

/** Normalises volatile parts (ids, numbers, timings, quoted values) so the same root cause groups together. */
export function signature(error = ""): string {
  const first = error.split("\n").find((l) => l.trim()) ?? "";
  return first
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?\s?(ms|s)\b/g, "<time>")
    .replace(/\d+/g, "<n>")
    .replace(/(["'`]).*?\1/g, "<value>")
    .trim()
    .slice(0, 160);
}

export interface FailureGroup extends Classified { signature: string; count: number; tests: string[]; sampleError: string }

export function triage(results: TestResult[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const r of results.filter((x) => x.status === "failed" || x.status === "flaky")) {
    const sig = signature(r.error);
    const key = `${classify(r.error).category}|${sig}`;
    const g = groups.get(key) ?? { ...classify(r.error), signature: sig, count: 0, tests: [], sampleError: (r.error ?? "").slice(0, 600) };
    g.count++;
    g.tests.push(r.status === "flaky" ? `${r.title} (flaky)` : r.title);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function triageMarkdown(groups: FailureGroup[]): string {
  if (!groups.length) return "No failures to triage. 🎉";
  const lines = [`## Failure triage: ${groups.reduce((s, g) => s + g.count, 0)} failures in ${groups.length} groups`, ""];
  groups.forEach((g, i) => {
    lines.push(`### ${i + 1}. ${g.category} — ${g.count} test(s)`);
    lines.push(`- **Signature:** \`${g.signature || "(empty error)"}\``);
    lines.push(`- **Likely cause:** ${g.likelyCause}`);
    lines.push(`- **Next step:** ${g.nextStep}`);
    lines.push(`- **Tests:** ${g.tests.slice(0, 8).join("; ")}${g.tests.length > 8 ? ` … +${g.tests.length - 8} more` : ""}`);
    lines.push("");
  });
  return lines.join("\n");
}
