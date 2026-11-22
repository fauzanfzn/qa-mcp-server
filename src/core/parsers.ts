import { readFileSync } from "node:fs";
import type { RunSummary, Status, TestResult } from "./types.js";

/** Detects the format from content and parses a Playwright JSON report or JUnit XML (Surefire, pytest, Jest-junit...). */
export function parseReport(path: string): RunSummary {
  const text = readFileSync(path, "utf8");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return parsePlaywrightJson(JSON.parse(text), path);
  if (trimmed.startsWith("<")) return parseJUnitXml(text, path);
  throw new Error(`Unsupported report format: ${path} (expected Playwright JSON or JUnit XML)`);
}

export function summarize(source: string, results: TestResult[]): RunSummary {
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  return {
    source,
    total: results.length,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    flaky: count("flaky"),
    durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    results,
  };
}

// ---------- Playwright JSON reporter ----------

interface PwSuite { title: string; file?: string; specs?: PwSpec[]; suites?: PwSuite[] }
interface PwSpec { title: string; file?: string; tests: PwTest[] }
interface PwTest { projectName?: string; status?: string; results: PwRun[] }
interface PwRun { status: string; duration: number; retry: number; error?: { message?: string } }

export function parsePlaywrightJson(report: { suites?: PwSuite[] }, source = "playwright"): RunSummary {
  const results: TestResult[] = [];
  const walk = (suite: PwSuite, path: string[], file?: string) => {
    const f = suite.file ?? file;
    const here = suite.title && suite.title !== f ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const runs = test.results ?? [];
        const last = runs[runs.length - 1];
        const anyPass = runs.some((r) => r.status === "passed");
        const anyFail = runs.some((r) => r.status === "failed" || r.status === "timedOut");
        let status: Status = "skipped";
        if (test.status === "flaky" || (anyPass && anyFail)) status = "flaky";
        else if (anyPass) status = "passed";
        else if (anyFail || test.status === "unexpected") status = "failed";
        const failedRun = [...runs].reverse().find((r) => r.error?.message);
        const project = test.projectName ? `[${test.projectName}] ` : "";
        results.push({
          id: [spec.file ?? f, ...here, spec.title, test.projectName].filter(Boolean).join(" > "),
          title: project + spec.title,
          file: spec.file ?? f,
          suite: here.join(" > ") || undefined,
          area: areaOf(spec.file ?? f, test.projectName),
          status,
          durationMs: runs.reduce((s, r) => s + (r.duration ?? 0), 0),
          retries: Math.max(0, runs.length - 1),
          error: status === "passed" ? undefined : stripAnsi(failedRun?.error?.message ?? last?.error?.message ?? ""),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here, f);
  };
  for (const s of report.suites ?? []) walk(s, [], s.file);
  return summarize(source, results);
}

// ---------- JUnit XML (no dependency: small, tolerant regex parser) ----------

export function parseJUnitXml(xml: string, source = "junit"): RunSummary {
  const results: TestResult[] = [];
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(xml))) {
    const attrs = attributes(m[1]);
    const body = m[3] ?? "";
    const classname = attrs.classname ?? "";
    const name = attrs.name ?? "unnamed";
    const failure = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/.exec(body);
    const flaky = /<(flakyFailure|flakyError|rerunFailure|rerunError)\b/.test(body);
    const skipped = /<skipped\b/.test(body);
    let status: Status = "passed";
    if (failure) status = "failed";
    else if (skipped) status = "skipped";
    else if (flaky) status = "flaky";
    const message = failure ? attributes(failure[2] ?? failure[5] ?? "").message ?? decode(failure[3] ?? "") : undefined;
    results.push({
      id: `${classname} > ${name}`,
      title: name,
      suite: classname || undefined,
      area: classname.split(".").pop() || "default",
      status,
      durationMs: Math.round(parseFloat(attrs.time ?? "0") * 1000),
      retries: (body.match(/<(flakyFailure|flakyError|rerunFailure|rerunError)\b/g) ?? []).length,
      error: message ? decode(message).trim() : undefined,
    });
  }
  return summarize(source, results);
}

function attributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of s.matchAll(/([\w:-]+)="([^"]*)"/g)) out[a[1]] = decode(a[2]);
  return out;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function areaOf(file?: string, project?: string): string {
  if (file) {
    const parts = file.replace(/\\/g, "/").split("/").filter((p) => p && p !== "tests" && p !== "e2e");
    if (parts.length > 1) return parts[0];
    if (parts.length === 1) return parts[0].replace(/\.(spec|test)\.[jt]s$/, "");
  }
  return project ?? "default";
}
