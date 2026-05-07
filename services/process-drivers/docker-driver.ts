import { IProcessDriver, ProcessInfo, StartOpts, OutputCallback } from "./types";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

const containerName = (slug: string) => `runpanel-${slug}`;

export const dockerDriver: IProcessDriver = {
  async start(slug: string, startCmd: string, opts: StartOpts): Promise<void> {
    const name = containerName(slug);
    // startCmd format: "docker:imageName"
    const imageName = startCmd.replace("docker:", "");

    // Remove existing container if any
    try {
      await exec("docker", ["rm", "-f", name], { timeout: 15_000 });
    } catch { /* ignore */ }

    // Build env args
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(opts.env)) {
      envArgs.push("-e", `${key}=${value}`);
    }

    // Port mapping — only if explicitly set by user (not the default fallback)
    const portArgs: string[] = [];
    if (opts.port && opts.port !== 3000) {
      portArgs.push("-p", `${opts.port}:${opts.port}`);
      envArgs.push("-e", `PORT=${opts.port}`);
    }

    // Check if project has a network (connect after run)
    const { ensureProjectNetwork } = await import("../docker-network");
    let networkArgs: string[] = [];
    try {
      const netName = await ensureProjectNetwork(slug);
      networkArgs = ["--network", netName];
    } catch { /* no network */ }

    // Run container
    await exec("docker", [
      "run", "-d",
      "--name", name,
      ...networkArgs,
      ...portArgs,
      ...envArgs,
      imageName,
    ], { timeout: 60_000 });
  },

  async stop(slug: string): Promise<void> {
    const name = containerName(slug);
    try {
      await exec("docker", ["rm", "-f", name], { timeout: 30_000 });
    } catch { /* might already be removed */ }
  },

  async restart(slug: string): Promise<void> {
    const name = containerName(slug);
    await exec("docker", ["restart", name], { timeout: 30_000 });
  },

  async status(slug: string): Promise<ProcessInfo> {
    const name = containerName(slug);
    try {
      const { stdout } = await exec("docker", [
        "inspect", name,
        "--format", "{{.State.Running}}|{{.State.Pid}}|{{.Id}}",
      ]);
      const [running, pid, containerId] = stdout.trim().split("|");

      if (running === "true") {
        // Get stats
        try {
          const { stdout: stats } = await exec("docker", [
            "stats", name, "--no-stream", "--format", "{{.MemUsage}}|{{.CPUPerc}}",
          ]);
          const [memStr, cpuStr] = stats.trim().split("|");
          const memMatch = memStr?.match(/([\d.]+)([MG]iB)/);
          const memory = memMatch
            ? parseFloat(memMatch[1]) * (memMatch[2] === "GiB" ? 1024 * 1024 * 1024 : 1024 * 1024)
            : undefined;
          const cpu = cpuStr ? parseFloat(cpuStr) : undefined;

          return {
            running: true,
            pid: parseInt(pid),
            containerId: containerId.slice(0, 12),
            memory,
            cpu,
          };
        } catch {
          return { running: true, pid: parseInt(pid), containerId: containerId.slice(0, 12) };
        }
      }

      return { running: false, containerId: containerId?.slice(0, 12) };
    } catch {
      return { running: false };
    }
  },

  async logs(slug: string, lines: number): Promise<string[]> {
    const name = containerName(slug);
    try {
      const { stdout, stderr } = await exec("docker", ["logs", name, "--tail", lines.toString()], {
        timeout: 10_000,
      });
      const combined = (stdout + "\n" + stderr).split("\n").filter(Boolean);
      return combined;
    } catch {
      return [];
    }
  },

  onOutput(slug: string, callback: OutputCallback): () => void {
    const name = containerName(slug);
    let stopped = false;

    const proc = execFile("docker", ["logs", name, "-f", "--tail", "0"]);

    proc.stdout?.on("data", (data: Buffer) => {
      if (stopped) return;
      data.toString().split("\n").forEach((line) => {
        if (line.trim()) callback(line, "stdout");
      });
    });

    proc.stderr?.on("data", (data: Buffer) => {
      if (stopped) return;
      data.toString().split("\n").forEach((line) => {
        if (line.trim()) callback(line, "stderr");
      });
    });

    return () => {
      stopped = true;
      proc.kill();
    };
  },
};
