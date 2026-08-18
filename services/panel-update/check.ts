import { getSetting, setSetting } from "@/lib/settings";
import {
  DEFAULT_PANEL_UPDATE_INTERVAL,
  PANEL_UPDATE_INTERVAL_SETTING,
} from "@/lib/polling";
import { authArgs, getGitHubToken, gitEnv } from "../git-auth";
import { whichSync } from "../env-utils";
import { notify } from "../notify";
import { explainGitError } from "./policy";
import {
  commitsBehind,
  countBehind,
  fetchRemote,
  readCheckout,
  remoteHead,
  type PanelCheckout,
  type PanelCommit,
} from "./git";

/**
 * Whether the panel has a new version waiting, asked on a timer.
 *
 * The shape is `services/deploy-poll.ts` turned inward, with one deliberate
 * difference that is the whole point of this feature: **the poller never
 * applies anything.** A project that asked for auto-deploy asked for its own
 * code to be rebuilt; nobody asks for the thing they are currently looking at
 * to restart underneath them. This finds out and says so, and that is all.
 *
 * The answer lives in `settings` as one JSON row. It is a singleton with a
 * handful of fields, which is precisely what that table is for — the same call
 * `services/autostart/install.ts` makes for its host config. No cache in front
 * of it: a point lookup on an indexed key is cheaper than the bookkeeping to
 * avoid it.
 */

export const PANEL_UPDATE_CHECK_SETTING = "panel_update_check";

export interface PanelUpdateCheck {
  checkedAt: string;
  branch: string | null;
  remote: string | null;
  localSha: string | null;
  remoteSha: string | null;
  behind: number;
  commits: PanelCommit[];
  /**
   * Why the last check could not answer, in words meant for a person.
   *
   * A string rather than a thrown error, and the reason is the one written at
   * the top of `services/autostart/probe.ts`: git missing, a remote that does
   * not answer and a directory that is not a checkout are all facts about this
   * host, not incidents. A check that throws on one of them tells the operator
   * nothing about the others.
   */
  error: string | null;
}

function empty(now: Date, error: string | null, checkout?: PanelCheckout): PanelUpdateCheck {
  return {
    checkedAt: now.toISOString(),
    branch: checkout?.branch ?? null,
    remote: checkout?.remote ?? null,
    localSha: checkout?.head ?? null,
    remoteSha: null,
    behind: 0,
    commits: [],
    error,
  };
}

/** The last recorded answer, or null if nothing has ever been checked. */
export async function lastCheck(): Promise<PanelUpdateCheck | null> {
  const raw = await getSetting(PANEL_UPDATE_CHECK_SETTING);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PanelUpdateCheck;
  } catch {
    return null;
  }
}

/**
 * Fetch, compare, remember.
 *
 * Recording the outcome even when it failed is on purpose: "checked twenty
 * minutes ago and could not reach github.com" is a different screen from "never
 * checked", and only one of them is a reason to look at the network.
 */
export async function checkPanelUpdate(now = new Date()): Promise<PanelUpdateCheck> {
  const previous = await lastCheck();
  const result = await produce(now);
  await setSetting(PANEL_UPDATE_CHECK_SETTING, JSON.stringify(result));

  /*
    Announced when the *target* moves, not when a check finds work to do.

    The difference matters because the check runs every six hours and an
    unapplied update stays unapplied: keying on "there is an update" would send
    the same message four times a day until somebody pressed the button, which
    is how a channel gets muted. Keying on the SHA changing sends it once per
    release, which is once per thing worth knowing.
  */
  if (result.behind > 0 && !result.error && result.remoteSha !== previous?.remoteSha) {
    void notify({
      key: "panel.update",
      behind: result.behind,
      from: result.localSha,
      to: result.remoteSha,
      branch: result.branch,
    });
  }

  return result;
}

async function produce(now: Date): Promise<PanelUpdateCheck> {
  if (!whichSync("git")) {
    return empty(now, "git non è installato o non è nel PATH di questo host.");
  }

  const checkout = await readCheckout();

  if (!checkout.isRepo) {
    return empty(
      now,
      "Questa installazione non è un checkout git, quindi il pannello non può aggiornarsi da sé."
    );
  }
  if (checkout.detached) {
    return empty(now, "HEAD è staccato: non c'è un branch da confrontare.", checkout);
  }
  if (!checkout.remote) {
    return empty(now, "Il checkout non ha un remote origin configurato.", checkout);
  }

  try {
    const token = await getGitHubToken();
    await fetchRemote(checkout, authArgs(token, checkout.remote), gitEnv());
  } catch (err) {
    return empty(now, message(err), checkout);
  }

  try {
    const [remoteSha, behind, commits] = await Promise.all([
      remoteHead(checkout),
      countBehind(checkout),
      commitsBehind(checkout),
    ]);

    return {
      checkedAt: now.toISOString(),
      branch: checkout.branch,
      remote: checkout.remote,
      localSha: checkout.head,
      remoteSha,
      behind,
      commits,
      error: null,
    };
  } catch (err) {
    return empty(now, `Confronto non riuscito: ${message(err)}`, checkout);
  }
}

function message(err: unknown): string {
  return explainGitError(err instanceof Error ? err.message : String(err));
}

// --- The timer ---------------------------------------------------------------

const globalRef = globalThis as typeof globalThis & {
  __runpanelUpdateTimer?: NodeJS.Timeout;
  __runpanelUpdateFirstTick?: NodeJS.Timeout;
};

/** Long enough after boot for the store to be ready and the panel to be serving. */
const FIRST_TICK_DELAY_MS = 45_000;

/**
 * The tick period, not the check period.
 *
 * Fifteen minutes with `checkedAt` deciding what is actually due, rather than an
 * interval equal to the setting: a panel restarted twice a day would otherwise
 * either check on every boot or never, depending on which side of the interval
 * the restart fell. `services/backup/scheduler.ts` takes the same line with its
 * stored last tick.
 */
const TICK_MS = 15 * 60_000;

export async function updateCheckIntervalSeconds(): Promise<number> {
  const raw = await getSetting(PANEL_UPDATE_INTERVAL_SETTING);
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : Number(DEFAULT_PANEL_UPDATE_INTERVAL);
}

export function startPanelUpdatePoller(): void {
  if (globalRef.__runpanelUpdateTimer) return;

  globalRef.__runpanelUpdateTimer = setInterval(() => void updateCheckTick(), TICK_MS);
  globalRef.__runpanelUpdateTimer.unref?.();

  globalRef.__runpanelUpdateFirstTick = setTimeout(() => void updateCheckTick(), FIRST_TICK_DELAY_MS);
  globalRef.__runpanelUpdateFirstTick.unref?.();
}

/** Exported so a test can drive a tick without waiting a quarter of an hour. */
export async function updateCheckTick(now = new Date()): Promise<PanelUpdateCheck | null> {
  try {
    const previous = await lastCheck();
    if (previous && !isDue(previous, now, (await updateCheckIntervalSeconds()) * 1000)) {
      return null;
    }
    return await checkPanelUpdate(now);
  } catch (err) {
    // A tick that throws must not kill the interval, or the panel quietly stops
    // noticing its own updates until someone restarts it.
    console.error("[panel-update] Controllo non riuscito:", err);
    return null;
  }
}

function isDue(previous: PanelUpdateCheck, now: Date, intervalMs: number): boolean {
  const last = Date.parse(previous.checkedAt);
  if (!Number.isFinite(last)) return true;
  // Half a tick of slack, for the reason `deploy-poll.ts` documents: ticks never
  // land exactly on the interval, and without it every interval quietly becomes
  // one tick longer than the operator asked for.
  return now.getTime() - last >= intervalMs - TICK_MS / 2;
}
