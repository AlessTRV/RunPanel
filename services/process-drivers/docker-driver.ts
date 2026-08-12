import { IProcessDriver, ProcessInfo, StartOpts, OutputCallback } from "./types";
import { docker, dockerTry, dockerStream, lines } from "../docker/cli";
import { appContainerName, labelArgs } from "../docker/labels";
import { containerStats } from "../docker/stats";
import { markRunStart, sinceArgs } from "./run-log";

export const dockerDriver: IProcessDriver = {
  async start(slug: string, startCmd: string, opts: StartOpts): Promise<void> {
    const name = appContainerName(slug);

    // A fresh container starts with an empty log, but a crash-restart under
    // `--restart` does not, and neither does `restart()`. The marker is what
    // makes `logs()` answer for this run in every one of those cases.
    markRunStart(slug);
    // startCmd format: "docker:imageRef"
    const imageName = startCmd.replace(/^docker:/, "");

    // Remove a leftover container with this name before recreating it.
    await dockerTry(["rm", "-f", name], { timeout: 15_000 });

    const network = opts.network ?? "project";
    const hostNetwork = network === "host";

    const args = [
      "run", "-d",
      "--name", name,
      // Containers used to start with no restart policy at all, so nothing came
      // back after a host reboot. Services already had this; apps did not.
      "--restart", opts.restartPolicy ?? "unless-stopped",
      ...labelArgs({ project: slug, kind: "app", deployment: opts.deploymentId }),
    ];

    if (hostNetwork) {
      // In host mode the container shares the host's stack: published ports and
      // host-gateway aliases are meaningless, and `localhost` already reaches
      // anything bound on the host.
      args.push("--network", "host");
    } else {
      args.push("--add-host=host.docker.internal:host-gateway");

      // Publish whenever a port is configured. The previous condition was
      // `opts.port !== 3000`, which meant the single most common port in the
      // world was never mapped.
      if (opts.port && opts.port > 0) {
        args.push("-p", `${opts.port}:${opts.port}`);
      }
    }

    for (const host of opts.extraHosts ?? []) args.push("--add-host", host);
    if (opts.hostname) args.push("--hostname", opts.hostname);
    for (const cap of opts.capAdd ?? []) args.push("--cap-add", cap);
    for (const mount of opts.mounts ?? []) args.push("-v", mount);
    if (opts.memory) args.push("--memory", opts.memory);
    if (opts.cpus) args.push("--cpus", opts.cpus);
    if (opts.shmSize) args.push("--shm-size", opts.shmSize);

    for (const [key, value] of Object.entries(opts.env)) {
      args.push("-e", `${key}=${value}`);
    }

    args.push(imageName);

    await docker(args, { timeout: 180_000 });

    // Join the project network too, keeping the default bridge for outbound
    // traffic. Not applicable in host mode, where there is no bridge to join.
    if (network === "project") {
      try {
        const { ensureProjectNetwork, connectToNetwork } = await import("../docker-network");
        await ensureProjectNetwork(slug);
        await connectToNetwork(name, slug);
      } catch {
        /* no project network needed */
      }
    }
  },

  async stop(slug: string): Promise<void> {
    // `stop`, not `rm -f`. Destroying the container on stop is why "start" had
    // to replay the previous deployment's command to bring anything back.
    await dockerTry(["stop", appContainerName(slug)], { timeout: 30_000 });
  },

  async remove(slug: string): Promise<void> {
    // A stopped container keeps its image referenced, so `docker rmi` on that
    // image silently fails and leaves it dangling.
    await dockerTry(["rm", "-f", appContainerName(slug)], { timeout: 30_000 });
  },

  async restart(slug: string): Promise<void> {
    markRunStart(slug);
    await docker(["restart", appContainerName(slug)], { timeout: 60_000 });
  },

  async status(slug: string): Promise<ProcessInfo> {
    const name = appContainerName(slug);
    const result = await dockerTry([
      "inspect", name,
      "--format", "{{.State.Running}}|{{.State.Pid}}|{{.Id}}|{{.State.StartedAt}}",
    ]);

    if (!result) return { running: false };

    const [running, pid, containerId, startedAt] = result.stdout.trim().split("|");
    const shortId = containerId?.slice(0, 12);

    if (running !== "true") return { running: false, containerId: shortId };

    let uptime: number | undefined;
    if (startedAt) {
      const started = new Date(startedAt).getTime();
      if (!Number.isNaN(started)) uptime = Math.floor((Date.now() - started) / 1000);
    }

    // Read from the streaming cache instead of spawning `docker stats
    // --no-stream`, which costs seconds per call.
    void containerStats.ensureStarted();
    const stats = containerStats.get(name);

    return {
      running: true,
      pid: Number.parseInt(pid, 10) || undefined,
      containerId: shortId,
      uptime,
      memory: stats?.memory,
      cpu: stats?.cpu,
    };
  },

  async logs(slug: string, count: number): Promise<string[]> {
    const name = appContainerName(slug);
    const result = await dockerTry(["logs", name, "--tail", count.toString(), ...sinceArgs(slug)], {
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (!result) return [];

    // Container output arrives on both streams.
    const combined = lines(`${result.stdout}\n${result.stderr}`);
    if (combined.length > 0) return combined;

    const state = await dockerTry([
      "inspect", name, "--format", "{{.State.Status}} {{.State.ExitCode}}",
    ], { timeout: 5_000 });

    const status = state?.stdout.trim();
    return status && status !== "running 0" ? [`[container state: ${status}]`] : [];
  },

  onOutput(slug: string, callback: OutputCallback): () => void {
    return dockerStream(["logs", appContainerName(slug), "-f", "--tail", "0"], (line) =>
      callback(line, "stdout")
    );
  },
};
