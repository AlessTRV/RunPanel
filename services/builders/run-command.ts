import { spawn } from "child_process";
import fs from "fs";
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

    // Node reports a missing working directory as ENOENT *on the executable*:
    // `spawn C:\Windows\system32\cmd.exe ENOENT`, which reads as "the shell is
    // missing" and sends you looking in entirely the wrong place. Check first
    // and say what is actually wrong.
    if (!fs.existsSync(cwd)) {
      reject(
        new Error(
          `Working directory does not exist: ${cwd}. ` +
            "The project has no source yet — configure a GitHub repository or upload a ZIP, then deploy."
        )
      );
      return;
    }

    const fullEnv = buildEnv(env);
    const shell = getShellPath();

    if (!fs.existsSync(shell)) {
      reject(new Error(`Shell not found at ${shell}`));
      return;
    }

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
