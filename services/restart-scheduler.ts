import { isValidTimeZone, nextAfter, parseCron } from "@/lib/cron";
import { getDb, nowIso, rowCount } from "@/lib/db";
import { decideRestart, describeOutcome, isDue } from "@/lib/scheduled-restart";
import { getSetting } from "@/lib/settings";
import { restartFromLastDeployment } from "./project-restart";
import { restartService } from "./service-provisioner";
import { notify } from "./notify";
import { serviceDisplayName } from "@/lib/service-name";

/**
 * The tick that makes a scheduled restart happen.
 *
 * Modelled on `services/backup/scheduler.ts`: the same thirty-second timer
 * behind the same globalThis guard, and the same claim — `restart_next_at` is
 * moved forward by a conditional UPDATE, so whoever wins owns the run and a
 * second tick cannot see the row as due. Nothing here depends on the period:
 * a target is restarted because its instant passed, once, not because a timer
 * fired.
 *
 * What to do with a target whose instant has passed is `decideRestart()` in
 * `lib/scheduled-restart.ts`, kept pure so the whole matrix is unit-tested. The
 * one rule worth repeating here: an operator's stop is respected, a crash gets
 * a single attempt, and the crash marker is cleared by that attempt whether it
 * worked or not.
 */

const TICK_MS = 30_000;
const FIRST_TICK_DELAY_MS = 15_000;

/** Written by the claim, replaced by the outcome once the restart returns. */
export const RESTART_IN_PROGRESS = "In corso";

const globalRef = globalThis as typeof globalThis & {
  __runpanelRestartTimer?: NodeJS.Timeout;
  __runpanelRestartFirstTick?: NodeJS.Timeout;
};

export function startRestartScheduler(): void {
  if (globalRef.__runpanelRestartTimer) return;

  globalRef.__runpanelRestartTimer = setInterval(() => void tick(), TICK_MS);
  globalRef.__runpanelRestartTimer.unref?.();

  globalRef.__runpanelRestartFirstTick = setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
  globalRef.__runpanelRestartFirstTick.unref?.();
}

async function panelTimeZone(): Promise<string> {
  const stored = await getSetting("timezone");
  return stored && isValidTimeZone(stored) ? stored : "UTC";
}

/**
 * The two columns a route writes when the schedule changes.
 *
 * The next occurrence is computed here and now, not left for the tick: the
 * page shows it as soon as the schedule is saved, and a schedule saved with
 * no `next` would otherwise fire on the first tick that computed one from a
 * `from` in the past.
 */
export async function restartScheduleColumns(
  cron: string,
  now = new Date()
): Promise<{ restart_cron: string; restart_next_at: string | null }> {
  if (!cron) return { restart_cron: "", restart_next_at: null };
  const parsed = parseCron(cron);
  if (!parsed.ok) throw new Error(parsed.error);
  const next = nextAfter(parsed.spec, now, await panelTimeZone());
  return { restart_cron: cron, restart_next_at: next ? next.toISOString() : null };
}

/**
 * Recompute every pending occurrence, for when the panel's zone changes.
 *
 * `restart_next_at` is an instant, computed in the zone that was current when
 * it was written. Moving the panel from UTC to Europe/Rome would otherwise
 * leave every nightly firing once more at the old wall-clock time.
 */
export async function rescheduleRestarts(now = new Date()): Promise<number> {
  const db = await getDb();
  const zone = await panelTimeZone();
  let moved = 0;

  for (const table of ["projects", "services"] as const) {
    const rows = await db
      .selectFrom(table)
      .select(["id", "restart_cron"])
      .where("restart_cron", "!=", "")
      .execute();

    for (const row of rows) {
      const parsed = parseCron(row.restart_cron ?? "");
      if (!parsed.ok) continue;
      const next = nextAfter(parsed.spec, now, zone);
      await db
        .updateTable(table)
        .set({ restart_next_at: next ? next.toISOString() : null, updated_at: nowIso() })
        .where("id", "=", row.id)
        .execute();
      moved++;
    }
  }

  return moved;
}

export interface RestartTickResult {
  due: number;
  restarted: number;
  skipped: number;
  failed: number;
}

type Table = "projects" | "services";

interface Target {
  table: Table;
  id: string;
  name: string;
  status: string;
  restart_cron: string;
  restart_next_at: string | null;
  crashed_at: string | null;
  /** What the driver needs: a project id, a service container name. */
  handle: string;
}

/** Exported so a test can drive a tick without waiting thirty seconds for one. */
export async function tick(now = new Date()): Promise<RestartTickResult> {
  const result: RestartTickResult = { due: 0, restarted: 0, skipped: 0, failed: 0 };

  try {
    const db = await getDb();
    const zone = await panelTimeZone();

    const projects = await db
      .selectFrom("projects")
      .select(["id", "name", "status", "restart_cron", "restart_next_at", "crashed_at"])
      .where("restart_cron", "!=", "")
      .execute();
    const services = await db
      .selectFrom("services")
      .select(["id", "name", "display_name", "status", "restart_cron", "restart_next_at", "crashed_at", "container_name"])
      .where("restart_cron", "!=", "")
      .execute();

    // The query already excluded empty and NULL expressions; `?? ""` only
    // narrows the type the nullable column declares.
    const targets: Target[] = [
      ...projects.map((p) => ({ table: "projects" as const, handle: p.id, ...p, restart_cron: p.restart_cron ?? "" })),
      ...services.map((s) => ({
        table: "services" as const,
        handle: s.container_name,
        ...s,
        name: serviceDisplayName(s),
        restart_cron: s.restart_cron ?? "",
      })),
    ];

    for (const target of targets) {
      const outcome = await consider(target, now, zone);
      if (outcome === "not-due") continue;
      result.due++;
      result[outcome]++;
    }
  } catch (err) {
    // A tick that throws must not kill the interval.
    console.error("[restart] Tick fallito:", err);
  }

  return result;
}

async function consider(
  target: Target,
  now: Date,
  zone: string
): Promise<"not-due" | "restarted" | "skipped" | "failed"> {
  const parsed = parseCron(target.restart_cron);
  if (!parsed.ok) {
    console.error(`[restart] Pianificazione non valida su "${target.name}": ${parsed.error}`);
    return "not-due";
  }

  // A row saved before this scheduler existed, or written by hand: give it a
  // next occurrence and nothing else — saving a schedule must not fire it.
  if (!target.restart_next_at) {
    await setNext(target, nextAfter(parsed.spec, now, zone));
    return "not-due";
  }

  if (!isDue(target.restart_next_at, now)) return "not-due";

  // Missed while the panel was down: nothing to catch up on. A restart is not
  // a backup — the next occurrence is the right moment, last night's is not.
  const decision = decideRestart({ status: target.status, crashedAt: target.crashed_at });
  const next = nextAfter(parsed.spec, now, zone);

  if (decision.action === "skip") {
    const outcome = describeOutcome(decision, null);
    if (!(await claim(target, next, now, outcome))) return "not-due";
    console.log(`[restart] "${target.name}": ${outcome}`);
    return "skipped";
  }

  // The claim clears the crash marker: this is the one attempt. If it fails,
  // the target stays stopped with no marker, and the next occurrence skips it.
  // "In corso" until the outcome lands: a project restart can take a while,
  // and the page should not show the previous occurrence's result meanwhile.
  if (!(await claim(target, next, now, RESTART_IN_PROGRESS, { clearCrash: true }))) return "not-due";

  let error: string | null = null;
  try {
    if (target.table === "projects") {
      const outcome = await restartFromLastDeployment(target.handle);
      if ("error" in outcome) error = outcome.error;
    } else {
      await restartService(target.handle);
      const db = await getDb();
      await db
        .updateTable("services")
        .set({ status: "running", updated_at: nowIso() })
        .where("id", "=", target.id)
        .execute();
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const outcome = describeOutcome(decision, error);
  await recordOutcome(target, outcome);
  console.log(`[restart] "${target.name}": ${outcome}`);
  void notify({
    key: "restart.scheduled",
    kind: target.table === "projects" ? "project" : "service",
    name: target.name,
    outcome,
    ok: error === null,
  });

  return error === null ? "restarted" : "failed";
}

/**
 * Claim the slot by moving `restart_next_at`, but only if it is still the
 * value we read. One conditional UPDATE on both drivers; the row count says
 * whether we won.
 */
async function claim(
  target: Target,
  next: Date | null,
  now: Date,
  outcome: string | null,
  opts: { clearCrash?: boolean } = {}
): Promise<boolean> {
  const db = await getDb();
  const result = await db
    .updateTable(target.table)
    .set({
      restart_next_at: next ? next.toISOString() : null,
      restart_last_at: now.toISOString(),
      restart_last_result: outcome,
      ...(opts.clearCrash ? { crashed_at: null } : {}),
      updated_at: nowIso(),
    })
    .where("id", "=", target.id)
    .where("restart_next_at", "=", target.restart_next_at)
    .executeTakeFirst();

  return rowCount(result) === 1;
}

async function setNext(target: Target, next: Date | null): Promise<void> {
  const db = await getDb();
  await db
    .updateTable(target.table)
    .set({ restart_next_at: next ? next.toISOString() : null, updated_at: nowIso() })
    .where("id", "=", target.id)
    .execute();
}

async function recordOutcome(target: Target, outcome: string): Promise<void> {
  const db = await getDb();
  await db
    .updateTable(target.table)
    .set({ restart_last_result: outcome, updated_at: nowIso() })
    .where("id", "=", target.id)
    .execute();
}
