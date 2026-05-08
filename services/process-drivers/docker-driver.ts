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

    // Run container on default bridge network (for internet + host.docker.internal access)
    await exec("docker", [
      "run", "-d",
      "--name", name,
      "--add-host=host.docker.internal:host-gateway",
      ...portArgs,
      ...envArgs,
      imageName,
    ], { timeout: 60_000 });

    // Also connect to project network (for container-to-container communication)
    try {
      const { ensureProjectNetwork, connectToNetwork } = await import("../docker-network");
      await ensureProjectNetwork(slug);
      await connectToNetwork(name, slug);
    } catch { /* no project network needed */ }
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
        "--format", "{{.State.Running}}|{{.State.Pid}}|{{.Id}}|{{.State.StartedAt}}",
      ]);
      const [running, pid, containerId, startedAt] = stdout.trim().split("|");

      if (running === "true") {
        // Calculate uptime from StartedAt
        let uptime: number | undefined;
        if (startedAt) {
          const started = new Date(startedAt).getTime();
          if (!isNaN(started)) {
            uptime = Math.floor((Date.now() - started) / 1000);
          }
        }

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
            uptime,
          };
        } catch {
          return { running: true, pid: parseInt(pid), containerId: containerId.slice(0, 12), uptime };
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
        maxBuffer: 10 * 1024 * 1024,
      });
      // Docker sends container output to both stdout and stderr
      const combined = (stdout.toString() + "\n" + stderr.toString()).split("\n").filter(Boolean);

      // If no logs, check if container is actually running
      if (combined.length === 0) {
        try {
          const { stdout: inspectOut } = await exec("docker", ["inspect", name, "--format", "{{.State.Status}} {{.State.ExitCode}}"], { timeout: 5_000 });
          const state = inspectOut.toString().trim();
          if (state && state !== "running 0") {
            return [`[container state: ${state}]`];
          }
        } catch { /* ignore */ }
      }

      return combined;
    } catch (err) {
      // If container doesn't exist, return empty. Otherwise log the error.
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("No such container")) {
        console.error(`[docker-logs] Error fetching logs for ${name}:`, msg);
      }
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
