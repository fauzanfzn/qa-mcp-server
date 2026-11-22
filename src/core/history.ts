import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunSummary, Status } from "./types.js";

interface Entry { at: string; status: Status }
type Store = Record<string, Entry[]>;

const MAX_RUNS = 30;

/** Keeps the last N outcomes per test in a small JSON file so flakiness can be measured across runs. */
export class History {
  constructor(private readonly file: string) {}

  load(): Store {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Store) : {};
  }

  record(run: RunSummary, at = new Date().toISOString()): number {
    const store = this.load();
    for (const r of run.results) {
      if (r.status === "skipped") continue;
      store[r.id] = [...(store[r.id] ?? []), { at, status: r.status }].slice(-MAX_RUNS);
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(store, null, 2));
    return run.results.length;
  }

  flaky(minRuns = 3): { id: string; runs: number; flipRate: number; failRate: number; lastStatus: Status }[] {
    return Object.entries(this.load())
      .filter(([, e]) => e.length >= minRuns)
      .map(([id, e]) => {
        let flips = 0;
        for (let i = 1; i < e.length; i++) if (pass(e[i].status) !== pass(e[i - 1].status)) flips++;
        const unstable = e.filter((x) => x.status !== "passed").length;
        return { id, runs: e.length, flipRate: round(flips / (e.length - 1)), failRate: round(unstable / e.length), lastStatus: e[e.length - 1].status };
      })
      .filter((x) => x.flipRate > 0 || x.lastStatus === "flaky")
      .sort((a, b) => b.flipRate - a.flipRate || b.failRate - a.failRate);
  }
}

const pass = (s: Status) => s === "passed";
const round = (n: number) => Math.round(n * 100) / 100;
