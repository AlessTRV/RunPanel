import type { DeployContract } from "@/lib/deploy-contract";
import { docker } from "./docker/cli";
import { labelArgs, networkName } from "./docker/labels";
import { ensureProjectNetwork } from "./docker-network";
import { runCommand } from "./builders/run-command";
import { processManager } from "./process-manager";

/**
 * The two deploy steps that have to behave the same on both runtimes but reach
 * that behaviour differently: the release command, and the health check.
 */

/**
 * Turn a multi-line command field into one shell invocation.
 *
 * Joined with `&&` rather than run line by line so the lines share a session:
 * `source venv/bin/activate` on one line has to still be in effect on the next,
 * and a separate spawn per line loses that. `&&` also stops the rest as soon as
 * one of them fails, which is what "eseguiti in ordine" has to mean.
 *
 * Here rather than in each caller because there were four copies of these three
 * lines — install and build in the node builder, the same pair in the custom
 * builder, and the release command below — and a fifth was about to be written
 * for the one-time commands.
 */
export function joinScript(command: string): string {
  return command
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" && ");
}

interface ReleaseOptions {
  runtimeType: string;
  slug: string;
  projectDir: string;
  /** Image reference, for container runtimes. */
  image: string;
  env: Record<string, string>;
  contract: DeployContract;
  onLog: (line: string) => void;
}

/**
 * Run the one-shot release command.
 *
 * Under Docker this is a throwaway container built from the image that is about
 * to run, on the same network and with the same mounts — so a migration reaches
 * the same database the app will. Running it on the host instead would need the
 * host to have the project's toolchain installed, which is the whole reason the
 * project was containerised.
 */
export async function runReleaseCommand(command: string, opts: ReleaseOptions): Promise<void> {
  const script = joinScript(command);

  if (!script) return;

  opts.onLog(`> ${script}`);

  if (opts.runtimeType !== "docker") {
    await runCommand(script, {
      cwd: opts.projectDir,
      env: opts.env,
      timeout: 600_000,
      onLog: opts.onLog,
    });
    return;
  }

  const network = opts.contract.docker.network;
  const args = ["run", "--rm", ...labelArgs({ project: opts.slug, kind: "app" })];

  if (network === "host") {
    args.push("--network", "host");
  } else if (network === "project") {
    // The release container runs BEFORE the app container, so the project
    // network may not exist yet — the app driver is what usually creates it.
    // Without this the very first deploy of a project fails at the release
    // step with "network not found".
    await ensureProjectNetwork(opts.slug);
    args.push("--network", networkName(opts.slug));
  }
  args.push("--add-host=host.docker.internal:host-gateway");

  for (const mount of opts.contract.docker.mounts) args.push("-v", mount);
  for (const [key, value] of Object.entries(opts.env)) args.push("-e", `${key}=${value}`);

  args.push(opts.image, "sh", "-c", script);

  const result = await docker(args, { timeout: 600_000 });
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    if (line.trim()) opts.onLog(line.trim());
  }
}

interface HealthOptions {
  slug: string;
  runtimeType: string;
  port: number;
  contract: DeployContract;
  onLog: (line: string) => void;
}

export interface HealthResult {
  healthy: boolean;
  reason?: string;
}

/**
 * Wait for the app to be genuinely up.
 *
 * The previous version hardcoded "GET / within 15 seconds", which fails any app
 * that boots slowly or answers on a different path — and reports that failure
 * as a broken deploy even though the app came up fine a moment later.
 */
export async function waitForHealthy(opts: HealthOptions): Promise<HealthResult> {
  const { healthcheck } = opts.contract;

  if (!healthcheck.enabled) {
    opts.onLog("Health check disabled — assuming the process is up.");
    return { healthy: true };
  }

  if (healthcheck.startPeriodSec > 0) {
    opts.onLog(`Waiting ${healthcheck.startPeriodSec}s before probing (start period)...`);
    await sleep(healthcheck.startPeriodSec * 1000);
  }

  const port = healthcheck.port ?? opts.port;
  const deadline = Date.now() + healthcheck.timeoutSec * 1000;
  let attempt = 0;
  let lastReason = "the process never reported as running";

  while (Date.now() < deadline) {
    attempt++;
    const info = await processManager.status(opts.slug, opts.runtimeType);

    if (!info.running) {
      lastReason = "the process is not running";
      if (attempt % 5 === 0) opts.onLog(`Not running yet (attempt ${attempt})...`);
      await sleep(healthcheck.intervalSec * 1000);
      continue;
    }

    // No port to probe: the process being alive is the whole signal.
    if (!port || port <= 0) {
      opts.onLog(`Process running (${info.containerId ?? info.pid ?? "n/a"}).`);
      return { healthy: true };
    }

    const probe = await probeHttp(port, healthcheck.path, healthcheck.expectStatus);
    if (probe.ok) {
      opts.onLog(`Health check passed — ${healthcheck.path} responded ${probe.status}.`);
      return { healthy: true };
    }

    lastReason = probe.reason;
    if (attempt % 5 === 0) {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      opts.onLog(`${probe.reason} (attempt ${attempt}, ${left}s left)...`);
    }

    await sleep(healthcheck.intervalSec * 1000);
  }

  return { healthy: false, reason: lastReason };
}

async function probeHttp(
  port: number,
  path: string,
  expectStatus: number[]
): Promise<{ ok: true; status: number } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: controller.signal,
      redirect: "manual",
    });

    // An empty expectStatus means "anything that answers": for most apps the
    // point is that the port is bound and serving, not the exact code.
    if (expectStatus.length === 0 || expectStatus.includes(res.status)) {
      return { ok: true, status: res.status };
    }
    return {
      ok: false,
      reason: `${path} responded ${res.status}, expected ${expectStatus.join(" or ")}`,
    };
  } catch {
    return { ok: false, reason: `port ${port} not responding on ${path}` };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
