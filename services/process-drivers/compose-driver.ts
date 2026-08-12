import { IProcessDriver, ProcessInfo, StartOpts, OutputCallback } from "./types";
import { getRepoPath } from "../git-manager";
import { containerStats } from "../docker/stats";
import { markRunStart, sinceArgs } from "./run-log";
import {
  composeContext,
  composeDown,
  composeFollow,
  composeLogs,
  composePs,
  composeRestart,
  composeStart,
  composeStop,
  composeUp,
} from "../docker/compose";

/**
 * Runs a project that ships its own compose file.
 *
 * `start` is `compose up`, not `compose start`: the stack has just been built
 * and its definition may have changed, so recreating from the file is the only
 * thing that reflects it. The `restart`/`stop` pair uses the compose verbs of
 * the same name, which act on the containers that already exist.
 */
function contextFor(slug: string) {
  const ctx = composeContext(slug, getRepoPath(slug));
  if (!ctx) throw new Error(`No compose file found for ${slug}`);
  return ctx;
}

export const composeDriver: IProcessDriver = {
  async start(slug: string, _startCmd: string, opts: StartOpts): Promise<void> {
    const ctx = contextFor(slug);
    // `up` recreates only what changed, so the services it leaves alone keep
    // every line they printed under the previous deploy.
    markRunStart(slug);
    await composeUp(ctx, { env: opts.env, onLog: opts.onLog });
  },

  async stop(slug: string): Promise<void> {
    await composeStop(contextFor(slug));
  },

  async remove(slug: string): Promise<void> {
    // Containers and networks go; named volumes stay, because they are the data.
    await composeDown(contextFor(slug));
  },

  async restart(slug: string): Promise<void> {
    const ctx = contextFor(slug);
    markRunStart(slug);
    try {
      await composeRestart(ctx);
    } catch {
      // A stack that was fully down cannot be restarted, only started.
      await composeStart(ctx);
    }
  },

  async status(slug: string): Promise<ProcessInfo> {
    let services;
    try {
      services = await composePs(contextFor(slug));
    } catch {
      return { running: false };
    }

    if (services.length === 0) return { running: false };

    // A stack is up when every service is. Reporting "running" while one
    // container is dead would hide exactly the failure worth seeing.
    const running = services.every((s) => s.state === "running");

    // Resource usage is the sum across the stack, read from the stats stream.
    void containerStats.ensureStarted();
    let cpu = 0;
    let memory = 0;
    let seen = false;
    for (const stat of containerStats.all()) {
      if (!stat.name.startsWith(`runpanel-${slug}`)) continue;
      cpu += stat.cpu;
      memory += stat.memory;
      seen = true;
    }

    return {
      running,
      cpu: seen ? Math.round(cpu * 10) / 10 : undefined,
      memory: seen ? memory : undefined,
    };
  },

  async logs(slug: string, count: number): Promise<string[]> {
    try {
      return await composeLogs(contextFor(slug), count, sinceArgs(slug));
    } catch {
      return [];
    }
  },

  onOutput(slug: string, callback: OutputCallback): () => void {
    try {
      return composeFollow(contextFor(slug), (line) => callback(line, "stdout"));
    } catch {
      return () => {};
    }
  },
};
