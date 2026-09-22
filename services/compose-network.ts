import fs from "fs";
import path from "path";
import { composeNetworkOverride, type ComposeNetworkOverride } from "@/lib/compose-network";
import { DockerError } from "./docker/cli";
import { composeConfigJson, composeOverridePath, type ComposeContext } from "./docker/compose";
import { ensureProjectNetwork } from "./docker-network";

/**
 * Putting a compose stack on the project network — the part with side effects.
 *
 * `lib/compose-network.ts` turns a resolved config into an override file; this
 * is what asks compose for the config, writes the file where the driver will
 * find it, and makes sure the network it names exists before `up` looks for
 * it. Kept out of the driver because the plan is also what the deploy needs
 * before it injects anything: a stack entirely on `network_mode: host` reaches
 * a service on `localhost`, not by container name, and that has to be known
 * before `DATABASE_URL` is built.
 */

export interface ComposeNetworkPlan {
  override: ComposeNetworkOverride | null;
  /** The whole stack runs on the host's network stack; nothing to attach. */
  hostOnly: boolean;
  /** `docker compose config` did not resolve; the message, for the log. */
  error: string | null;
}

/**
 * Ask compose what the stack looks like and decide what to attach.
 *
 * Resolved against the base file only — never the previous override, which
 * would report every service as already attached and hide a service the user
 * added since. A file that fails to resolve is reported rather than thrown:
 * the builder validates it again a moment later with a clearer message, and
 * the deploy should fail there, not here.
 */
export async function planComposeNetwork(
  ctx: ComposeContext,
  env: Record<string, string>
): Promise<ComposeNetworkPlan> {
  try {
    const resolved = await composeConfigJson(ctx, env);
    const override = composeNetworkOverride(resolved, ctx.slug);
    const services = Object.keys(resolved.services ?? {});
    return { override, hostOnly: override === null && services.length > 0, error: null };
  } catch (err: unknown) {
    const message =
      err instanceof DockerError ? err.stderr || err.message : err instanceof Error ? err.message : String(err);
    return { override: null, hostOnly: false, error: message };
  }
}

/**
 * Write the override for the next `up`, or remove a stale one.
 *
 * The network is created here too: the override declares it `external`, so
 * `up` refuses to start until it exists, and a compose project may well be the
 * first thing in its project to be started.
 */
export async function applyComposeNetwork(slug: string, plan: ComposeNetworkPlan): Promise<string | null> {
  const target = composeOverridePath(slug);

  if (!plan.override) {
    removeComposeOverride(slug);
    return null;
  }

  await ensureProjectNetwork(slug);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, plan.override.text, "utf8");
  return target;
}

export function removeComposeOverride(slug: string): void {
  try {
    fs.rmSync(composeOverridePath(slug), { force: true });
  } catch {
    /* nothing to remove */
  }
}

/** The network mode the injection should assume for a compose stack. */
export function composeNetworkMode(plan: ComposeNetworkPlan | null): "project" | "host" {
  return plan?.hostOnly ? "host" : "project";
}
