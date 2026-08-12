import type { ProjectsTable, ServicesTable } from "./db/schema";

/**
 * What "start this at boot" means for a row, in one place.
 *
 * The four columns are nullable — SQLite cannot add a NOT NULL column to a
 * populated table — so every row created after migration 005 arrives with them
 * unset. Rather than writing defaults at each insert site (three today, more
 * later, and they drift), the defaults live here and every reader goes through
 * `resolveAutostart`. A row that was backfilled and a row that was never
 * touched then answer identically.
 *
 * Migration 005 repeats these numbers as literals on purpose: a migration is a
 * snapshot of a moment, and importing a constant that later changes would
 * rewrite history the next time someone migrates from scratch.
 */

export type AutostartKind = "project" | "service";

export interface AutostartSettings {
  autostart: boolean;
  /** Lower goes first. Services are started before projects regardless. */
  order: number;
  /** Pause after this one is up, before the next one starts. */
  delaySeconds: number;
  /** Block the queue until a readiness probe passes. */
  waitHealthy: boolean;
}

/**
 * A database that does not come back is worse than an app that does not, and an
 * app whose database is missing fails in a way that looks like a bug in the app.
 * So a service defaults to starting, and to being waited for; a project has to
 * be asked for explicitly.
 */
export const AUTOSTART_DEFAULTS: Record<AutostartKind, AutostartSettings> = {
  service: { autostart: true, order: 50, delaySeconds: 0, waitHealthy: true },
  project: { autostart: false, order: 100, delaySeconds: 0, waitHealthy: false },
};

/** The columns as stored, on either table. */
export type AutostartColumns = Pick<
  ProjectsTable | ServicesTable,
  "autostart" | "autostart_order" | "autostart_delay_s" | "autostart_wait_healthy"
>;

function flag(value: number | null | undefined, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  return value === 1;
}

function count(value: number | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  return value;
}

export function resolveAutostart(kind: AutostartKind, row: AutostartColumns): AutostartSettings {
  const d = AUTOSTART_DEFAULTS[kind];
  return {
    autostart: flag(row.autostart, d.autostart),
    order: count(row.autostart_order, d.order),
    delaySeconds: count(row.autostart_delay_s, d.delaySeconds),
    waitHealthy: flag(row.autostart_wait_healthy, d.waitHealthy),
  };
}

/** The other direction: a partial edit from the UI turned into columns to write. */
export function autostartColumns(patch: Partial<AutostartSettings>): Partial<AutostartColumns> {
  const out: Partial<AutostartColumns> = {};
  if (patch.autostart !== undefined) out.autostart = patch.autostart ? 1 : 0;
  if (patch.order !== undefined) out.autostart_order = patch.order;
  if (patch.delaySeconds !== undefined) out.autostart_delay_s = patch.delaySeconds;
  if (patch.waitHealthy !== undefined) out.autostart_wait_healthy = patch.waitHealthy ? 1 : 0;
  return out;
}

/**
 * Boot order across both tables: services first, then projects, each by its own
 * `order`. Ties fall back to creation time so the sequence is stable between
 * boots rather than depending on how the rows came back from the database.
 */
export function compareAutostart(
  a: { kind: AutostartKind; order: number; createdAt: string },
  b: { kind: AutostartKind; order: number; createdAt: string }
): number {
  if (a.kind !== b.kind) return a.kind === "service" ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  return a.createdAt.localeCompare(b.createdAt);
}
