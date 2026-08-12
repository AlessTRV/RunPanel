import fs from "fs";
import path from "path";
import { config } from "@/lib/config";

/**
 * Where the run you are looking at begins.
 *
 * `logs()` has to answer "what did this run print", not "what has this project
 * ever printed". That stopped being a cosmetic distinction the day a failed
 * deploy printed its log tail and the tail came from three deploys earlier: the
 * output was real, but it described a configuration that no longer existed, and
 * it sent the diagnosis somewhere else entirely for twenty minutes.
 *
 * A run starts when RunPanel starts the process — a deploy, or the start/restart
 * buttons. Deliberately NOT when the runtime restarts the process on its own: a
 * container crash-looping under `--restart unless-stopped`, or an app PM2 keeps
 * reviving, prints its reason once per attempt, and hiding every attempt but the
 * last one hides the only useful evidence.
 *
 * Two implementations, because the two runtimes own their output differently.
 * PM2 writes to files RunPanel created, so those are simply truncated — which
 * also stops them growing without bound, since nothing ever rotated them.
 * Docker's logs belong to the daemon and cannot be truncated from here, so the
 * moment the run began is recorded and handed to `--since`.
 */

function runsDir(): string {
  return path.join(config.logsDir, "runs");
}

function runFile(slug: string): string {
  return path.join(runsDir(), `${slug}.txt`);
}

/** Called by the drivers that cannot truncate, at the start of every run. */
export function markRunStart(slug: string): void {
  try {
    fs.mkdirSync(runsDir(), { recursive: true });
    fs.writeFileSync(runFile(slug), new Date().toISOString());
  } catch {
    /* losing the marker costs an over-long log, not a broken deploy */
  }
}

/**
 * `--since` for the current run, or nothing if it was never recorded — an
 * upgrade over a project started by an older version, where showing everything
 * is better than showing nothing.
 */
export function sinceArgs(slug: string): string[] {
  try {
    const stamp = fs.readFileSync(runFile(slug), "utf8").trim();
    return stamp ? ["--since", stamp] : [];
  } catch {
    return [];
  }
}

export function forgetRun(slug: string): void {
  try {
    fs.rmSync(runFile(slug), { force: true });
  } catch {
    /* ignore */
  }
}
