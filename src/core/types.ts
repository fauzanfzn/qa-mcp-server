export type Status = "passed" | "failed" | "skipped" | "flaky";

export interface TestResult {
  id: string;            // stable id: file > suite > title
  title: string;
  file?: string;
  suite?: string;
  area: string;          // feature area used for readiness (first folder or suite)
  status: Status;
  durationMs: number;
  retries: number;
  error?: string;
}

export interface RunSummary {
  source: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
  results: TestResult[];
}
