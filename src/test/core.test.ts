import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { draftBugReport } from "../core/bugreport.js";
import { History } from "../core/history.js";
import { parseReport, summarize } from "../core/parsers.js";
import { readiness } from "../core/readiness.js";
import { classify, signature, triage } from "../core/triage.js";

const PW = join(process.cwd(), "fixtures/playwright-report.json");
const JU = join(process.cwd(), "fixtures/junit-report.xml");

test("parses Playwright JSON: totals, flaky detection, nested suites, areas", () => {
  const run = parseReport(PW);
  assert.deepEqual({ total: run.total, passed: run.passed, failed: run.failed, flaky: run.flaky, skipped: run.skipped },
    { total: 9, passed: 3, failed: 4, flaky: 1, skipped: 1 });
  const voucher = run.results.find((r) => r.title.includes("applies voucher"))!;
  assert.equal(voucher.status, "flaky");
  assert.equal(voucher.retries, 1);
  assert.equal(run.results.find((r) => r.title.includes("locked user"))!.suite, "Login");
  assert.deepEqual([...new Set(run.results.map((r) => r.area))].sort(), ["api", "auth", "checkout"]);
});

test("parses JUnit XML: failures, errors, skipped, flaky reruns, entities", () => {
  const run = parseReport(JU);
  assert.deepEqual({ total: run.total, passed: run.passed, failed: run.failed, flaky: run.flaky, skipped: run.skipped },
    { total: 6, passed: 2, failed: 2, flaky: 1, skipped: 1 });
  assert.equal(run.results.find((r) => r.title === "update_requires_token")!.error, "Expected status code <403> but was <200>.");
});

test("rejects unknown formats", () => {
  assert.throws(() => parseReport(join(process.cwd(), "package.json").replace("package.json", "tsconfig.json").replace("tsconfig.json", "README.md")));
});

test("classifies common failure causes", () => {
  assert.equal(classify("Error: locator.click: Timeout 30000ms exceeded. waiting for getByTestId('x')").category, "locator");
  assert.equal(classify("Test timeout of 30000ms exceeded.").category, "timeout");
  assert.equal(classify("apiRequestContext.get: 503 Service Unavailable").category, "server-error");
  assert.equal(classify("Connection refused: localhost/127.0.0.1:8080").category, "network");
  assert.equal(classify("Expected status code <403> but was <200>.").category, "auth");
  assert.equal(classify("ZodError: required property 'id'").category, "contract");
  assert.equal(classify("expect(received).toBe(expected)").category, "assertion");
  assert.equal(classify("weird").category, "unknown");
});

test("signature normalises volatile values so same root cause groups together", () => {
  assert.equal(signature("Timeout 30000ms exceeded for order 123"), signature("Timeout 5000ms exceeded for order 987"));
  assert.notEqual(signature("503 Service Unavailable"), signature("expect(x).toBe(y)"));
});

test("triage groups the two 503s into one group, largest first", () => {
  const groups = triage(parseReport(PW).results);
  assert.equal(groups[0].category, "server-error");
  assert.equal(groups[0].count, 2);
  assert.equal(groups.reduce((s, g) => s + g.count, 0), 5); // 4 failed + 1 flaky
});

test("readiness: flaky counts half, critical areas block release", () => {
  const run = parseReport(PW);
  const r = readiness(run);
  assert.equal(r.overall, 43.8); // (3 + 0.5) / 8 executed
  assert.equal(r.verdict, "NOT READY");
  const clean = summarize("x", run.results.filter((t) => t.area === "auth" && t.status !== "failed"));
  assert.equal(readiness(clean).verdict, "READY");
  const risky = summarize("x", [
    ...Array.from({ length: 19 }, (_, i) => ({ id: `t${i}`, title: `t${i}`, area: "cart", status: "passed" as const, durationMs: 1, retries: 0 })),
    { id: "p", title: "pay", area: "payment", status: "failed" as const, durationMs: 1, retries: 0, error: "x" },
  ]);
  assert.equal(readiness(risky, { threshold: 95 }).verdict, "READY");
  assert.equal(readiness(risky, { threshold: 95, criticalAreas: ["payment"] }).verdict, "NOT READY");
});

test("history detects tests that flip between runs", () => {
  const h = new History(join(mkdtempSync(join(tmpdir(), "qa-")), "h.json"));
  const run = parseReport(JU);
  const flip = (status: "passed" | "failed") => summarize("x", run.results.map((r) => r.title === "create_booking" ? { ...r, status } : { ...r, status: r.status === "skipped" ? "skipped" : "passed" }));
  h.record(flip("passed"), "1"); h.record(flip("failed"), "2"); h.record(flip("passed"), "3");
  const flaky = h.flaky(3);
  assert.equal(flaky.length, 1);
  assert.match(flaky[0].id, /create_booking/);
  assert.equal(flaky[0].flipRate, 1);
});

test("bug report never invents steps and includes triage notes", () => {
  const failed = parseReport(PW).results.find((r) => r.title.includes("declined"))!;
  const md = draftBugReport({ result: failed, environment: "staging" });
  assert.match(md, /TODO: confirm the manual steps/);
  assert.match(md, /Card declined/);
  assert.match(md, /\*\*Environment:\*\* staging/);
  assert.match(md, /Category:\*\* assertion/);
});

test("a failed expect on a locator is an assertion, not a locator problem", () => {
  assert.equal(classify('Error: expect(locator).toHaveText(expected)\nExpected string: "A"\nReceived string: "B"').category, "assertion");
});
