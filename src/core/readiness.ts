import type { RunSummary } from "./types.js";

export interface AreaScore { area: string; total: number; passed: number; failed: number; flaky: number; skipped: number; readiness: number }
export interface Readiness { overall: number; verdict: "READY" | "AT RISK" | "NOT READY"; areas: AreaScore[]; blockers: string[] }

/**
 * Readiness = passed / (executed) per area, where flaky counts as half a pass:
 * a test that only passes on retry is a risk signal, not a clean pass.
 * Verdict: READY at >= threshold with no failures in critical areas.
 */
export function readiness(run: RunSummary, opts: { threshold?: number; criticalAreas?: string[] } = {}): Readiness {
  const threshold = opts.threshold ?? 95;
  const critical = new Set((opts.criticalAreas ?? []).map((a) => a.toLowerCase()));
  const byArea = new Map<string, AreaScore>();
  for (const r of run.results) {
    const a = byArea.get(r.area) ?? { area: r.area, total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, readiness: 0 };
    a.total++;
    a[r.status]++;
    byArea.set(r.area, a);
  }
  const score = (passed: number, flaky: number, executed: number) =>
    executed === 0 ? 100 : Math.round(((passed + flaky * 0.5) / executed) * 1000) / 10;
  const areas = [...byArea.values()].map((a) => ({ ...a, readiness: score(a.passed, a.flaky, a.total - a.skipped) }))
    .sort((x, y) => x.readiness - y.readiness);
  const overall = score(run.passed, run.flaky, run.total - run.skipped);
  const blockers = run.results
    .filter((r) => r.status === "failed" && (critical.size === 0 || critical.has(r.area.toLowerCase())))
    .map((r) => `${r.area}: ${r.title}`);
  const criticalFailed = run.results.some((r) => r.status === "failed" && critical.has(r.area.toLowerCase()));
  const verdict = overall >= threshold && !criticalFailed ? "READY" : overall >= threshold - 15 && !criticalFailed ? "AT RISK" : "NOT READY";
  return { overall, verdict, areas, blockers };
}

export function readinessMarkdown(r: Readiness): string {
  const lines = [`## Release readiness: ${r.overall}% — ${r.verdict}`, "", "| Area | Readiness | Passed | Failed | Flaky | Skipped |", "| --- | ---: | ---: | ---: | ---: | ---: |"];
  for (const a of r.areas) lines.push(`| ${a.failed ? "❌" : a.flaky ? "⚠️" : "✅"} ${a.area} | ${a.readiness}% | ${a.passed} | ${a.failed} | ${a.flaky} | ${a.skipped} |`);
  if (r.blockers.length) lines.push("", "**Blockers**", ...r.blockers.slice(0, 15).map((b) => `- ${b}`));
  return lines.join("\n");
}
