import { spawn } from "child_process";
import { buildEnv, getShellPath, isWindows } from "../env-utils";

export interface RunCommandOpts {
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  onLog: (line: string) => void;
}

export function runCommand(command: string, opts: RunCommandOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    const { cwd, env, timeout = 300_000, onLog } = opts;

    const fullEnv = buildEnv(env);
    const shell = getShellPath();

    const proc = isWindows
      ? spawn(shell, ["/c", command], {
          cwd,
          env: fullEnv,
          stdio: ["ignore", "pipe", "pipe"],
          timeout,
          windowsHide: true,
        })
      : spawn(shell, ["-c", command], {
          cwd,
          env: fullEnv,
          stdio: ["ignore", "pipe", "pipe"],
          timeout,
        });

    let lastLine = "";

    proc.stdout.on("data", (data: Buffer) => {
      const text = lastLine + data.toString();
      const lines = text.split("\n");
      lastLine = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) onLog(line);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) onLog(`[stderr] ${line}`);
      }
    });

    proc.on("close", (code) => {
      if (lastLine.trim()) onLog(lastLine);
      if (code === 0) resolve();
      else reject(new Error(`Command "${command}" exited with code ${code}`));
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to run "${command}": ${err.message}`));
    });
  });
}
