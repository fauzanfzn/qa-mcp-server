import { spawn } from "node:child_process";

export interface RunOutput { exitCode: number; durationMs: number; stdoutTail: string; stderrTail: string }

/**
 * Runs a test command without a shell (arguments are passed as an array, so nothing is interpolated).
 * Only commands whose binary is in the allow-list can run: an AI client should never get arbitrary execution.
 */
export function runCommand(command: string, args: string[], opts: { cwd: string; timeoutMs: number; allow: string[]; env?: NodeJS.ProcessEnv }): Promise<RunOutput> {
  if (!opts.allow.includes(command)) {
    return Promise.reject(new Error(`Command "${command}" is not allowed. Allowed: ${opts.allow.join(", ")} (set QA_MCP_ALLOWED_COMMANDS)`));
  }
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, shell: false });
    let out = "", err = "";
    const keep = (buf: string, chunk: Buffer) => (buf + chunk.toString()).slice(-8000);
    child.stdout.on("data", (c: Buffer) => (out = keep(out, c)));
    child.stderr.on("data", (c: Buffer) => (err = keep(err, c)));
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, durationMs: Date.now() - start, stdoutTail: out.slice(-3000), stderrTail: err.slice(-2000) });
    });
  });
}
