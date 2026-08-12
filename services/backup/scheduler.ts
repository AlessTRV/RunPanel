import { nextAfter, parseCron, type CronSpec } from "@/lib/cron";
import { getDb, nowIso, rowCount } from "@/lib/db";
import type { BackupPoliciesTable } from "@/lib/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { removePartialArchives } from "./paths";
import { BackupBusyError, runBackup } from "./runner";
import type { BackupTarget } from "./types";

/**
 * The tick that makes a schedule happen.
 *
 * Modelled on `startGcScheduler()` in services/docker/gc.ts — same globalThis
 * guard so a dev-mode reload does not end up with two timers, same `.unref()`
 * so a background chore never keeps the process alive.
 *
 * Thirty seconds and not sixty: with drift, a sixty-second timer can step over
 * a minute entirely. Nothing is repeated because of the period anyway — the
 * guarantee comes from `next_run_at`, which only ever moves forward.
 */

const TICK_MS = 30_000;
const TICK_SETTING = "backup_scheduler_last_tick";
/** Long enough after boot for the store and Docker to be ready. */
const FIRST_TICK_DELAY_MS = 15_000;
/** A missed run older than this is history, not something to catch up on. */
const CATCH_UP_FLOOR_MS = 24 * 60 * 60 * 1000;

const globalRef = globalThis as typeof globalThis & {
  __runpanelBackupTimer?: NodeJS.Timeout;
  __runpanelBackupFirstTick?: NodeJS.Timeout;
};

export function startBackupScheduler(): void {
  if (globalRef.__runpanelBackupTimer) return;

  const removed = removePartialArchives();
  if (removed > 0) {
    console.log(`[backup] Rimossi ${removed} archivi incompleti lasciati da un'interruzione`);
  }

  globalRef.__runpanelBackupTimer = setInterval(() => void tick(), TICK_MS);
  globalRef.__runpanelBackupTimer.unref?.();

  // The first tick is where a missed schedule is noticed, so it should not wait
  // for the interval — but it should not race the boot either.
  globalRef.__runpanelBackupFirstTick = setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
  globalRef.__runpanelBackupFirstTick.unref?.();
}


export interface TickResult {
  due: number;
  started: number;
  skipped: number;
  caughtUp: number;
}

/** Exported so a test can drive a tick without waiting thirty seconds for one. */
export async function tick(now = new Date()): Promise<TickResult> {
  const result: TickResult = { due: 0, started: 0, skipped: 0, caughtUp: 0 };

  try {
    const db = await getDb();
    const lastTick = await getSetting(TICK_SETTING);
    // More than two intervals since the last tick means the panel was not
    // running. Everything overdue right now was missed rather than late.
    const wasDown = lastTick ? now.getTime() - Date.parse(lastTick) > 2 * TICK_MS : true;

    const policies = await db
      .selectFrom("backup_policies")
      .selectAll()
      .where("enabled", "=", 1)
      .where("cron", "!=", "")
      .execute();

    for (const policy of policies) {
      const outcome = await considerPolicy(policy, now, wasDown);
      if (outcome === "not-due") continue;

      result.due++;
      if (outcome === "started") result.started++;
      if (outcome === "caught-up") {
        result.started++;
        result.caughtUp++;
      }
      if (outcome === "skipped") result.skipped++;
    }

    await setSetting(TICK_SETTING, now.toISOString());
  } catch (err) {
    // A tick that throws must not kill the interval, or the panel silently
    // stops taking backups until someone restarts it.
    console.error("[backup] Tick fallito:", err);
  }

  return result;
}

type Outcome = "not-due" | "started" | "caught-up" | "skipped";

async function considerPolicy(
  policy: BackupPoliciesTable,
  now: Date,
  wasDown: boolean
): Promise<Outcome> {
  const parsed = parseCron(policy.cron);
  if (!parsed.ok) {
    console.error(`[backup] Pianificazione non valida su "${policy.name}": ${parsed.error}`);
    return "not-due";
  }

  const zone = policy.timezone ?? (await panelTimeZone());

  // A policy that has never been scheduled gets a next time and nothing else:
  // saving one should not fire it.
  if (!policy.next_run_at) {
    await setNextRun(policy.id, nextAfter(parsed.spec, now, zone));
    return "not-due";
  }

  const dueAt = Date.parse(policy.next_run_at);
  if (!Number.isFinite(dueAt) || dueAt > now.getTime()) return "not-due";

  const overdueBy = now.getTime() - dueAt;
  let catchingUp = false;

  if (wasDown) {
    const spacing = estimateSpacing(parsed.spec, now, zone);
    const window = Math.max(2 * spacing, CATCH_UP_FLOOR_MS);
    if (overdueBy > window) {
      // Down for a month. Running "last month's nightly" now would dump over a
      // database that has since been restored from somewhere else.
      console.log(
        `[backup] "${policy.name}": esecuzione persa da troppo tempo (${Math.round(overdueBy / 3_600_000)}h), la salto`
      );
      await claim(policy, nextAfter(parsed.spec, now, zone), now);
      return "skipped";
    }
    catchingUp = overdueBy > TICK_MS * 2;
  }

  // The claim and the reschedule are the same statement: whoever wins the
  // conditional update owns the run, and `next_run_at` has already moved so a
  // second tick cannot see it as due. Exactly the trick deploy-queue.ts uses.
  const next = nextAfter(parsed.spec, now, zone);
  if (!(await claim(policy, next, now))) return "not-due";

  if (catchingUp) {
    console.log(`[backup] "${policy.name}": recupero di un'esecuzione persa`);
  }

  try {
    await runBackup({
      trigger: "schedule",
      targets: parseTargets(policy.targets),
      destinationId: policy.destination_id,
      policyId: policy.id,
      policyName: policy.name,
      includeSecretKey: policy.include_secret_key === 1,
    });
  } catch (err) {
    if (err instanceof BackupBusyError) {
      // Unlike a deploy, a missed nightly is not worth queueing: the host is
      // already busy doing the thing this would pile onto, and the next
      // occurrence will take it.
      console.log(`[backup] "${policy.name}": un backup è già in corso, salto questa esecuzione`);
      return "skipped";
    }
    console.error(`[backup] "${policy.name}" è fallita:`, err);
  }

  return catchingUp ? "caught-up" : "started";
}

/**
 * Claim the slot by moving `next_run_at`, but only if it is still the value we
 * read. On both drivers this is one conditional UPDATE, and the row count says
 * whether we won.
 */
async function claim(
  policy: BackupPoliciesTable,
  next: Date | null,
  now: Date
): Promise<boolean> {
  const db = await getDb();
  const result = await db
    .updateTable("backup_policies")
    .set({
      next_run_at: next ? next.toISOString() : null,
      last_run_at: now.toISOString(),
      updated_at: nowIso(),
    })
    .where("id", "=", policy.id)
    .where("next_run_at", "=", policy.next_run_at)
    .executeTakeFirst();

  return rowCount(result) === 1;
}

async function setNextRun(policyId: string, next: Date | null): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("backup_policies")
    .set({ next_run_at: next ? next.toISOString() : null, updated_at: nowIso() })
    .where("id", "=", policyId)
    .execute();
}

/** How far apart this schedule's runs are, used to size the catch-up window. */
function estimateSpacing(spec: CronSpec, now: Date, zone: string): number {
  const first = nextAfter(spec, now, zone);
  if (!first) return CATCH_UP_FLOOR_MS;
  const second = nextAfter(spec, first, zone);
  if (!second) return CATCH_UP_FLOOR_MS;
  return second.getTime() - first.getTime();
}

export function parseTargets(raw: string): BackupTarget[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BackupTarget[]) : [];
  } catch {
    return [];
  }
}

async function panelTimeZone(): Promise<string> {
  // Never the host's zone: a panel moved between machines would silently start
  // running its nightly at a different time.
  return (await getSetting("timezone")) ?? "UTC";
}

/**
 * Recompute when a policy should next run. Called after it is created or its
 * schedule is edited, so the list shows the truth immediately instead of after
 * the next tick.
 */
export async function refreshNextRun(policyId: string): Promise<string | null> {
  const db = await getDb();
  const policy = await db
    .selectFrom("backup_policies")
    .selectAll()
    .where("id", "=", policyId)
    .executeTakeFirst();

  if (!policy) return null;

  if (!policy.enabled || !policy.cron) {
    await setNextRun(policyId, null);
    return null;
  }

  const parsed = parseCron(policy.cron);
  if (!parsed.ok) {
    await setNextRun(policyId, null);
    return null;
  }

  const zone = policy.timezone ?? (await panelTimeZone());
  const next = nextAfter(parsed.spec, new Date(), zone);
  await setNextRun(policyId, next);
  return next ? next.toISOString() : null;
}
