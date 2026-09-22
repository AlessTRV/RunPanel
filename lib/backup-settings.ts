/**
 * How a project's volumes are backed up.
 *
 * Stored as JSON in `projects.backup_settings` — see migration 021 — where NULL
 * means every default. Read tolerantly: a value this version cannot make sense
 * of falls back to the default for that one field, never to "no backup". The
 * API validates what it writes with `projectBackupSettingsSchema`.
 *
 * No imports, so the unit suite loads it directly.
 */

/**
 * What happens to the containers writing into a volume while it is copied.
 *
 *  - `pause`: they are frozen with `docker pause` for as long as the copy
 *    reads, which makes it crash-consistent — the state a power cut would have
 *    left, which SQLite and Postgres both recover from by design.
 *  - `live`: they keep running. The copy may be inconsistent, and the log and
 *    the manifest say so every time.
 */
export type VolumeConsistency = "pause" | "live";

export interface PreBackupCommand {
  /** A service of the project's Compose stack. */
  service: string;
  /** Run with `sh -c` inside that service's running container. */
  command: string;
  timeoutSec: number;
}

export interface ProjectBackupSettings {
  consistency: VolumeConsistency;
  /** Run once per backup, before the first of the project's volumes is copied. */
  preBackup: PreBackupCommand | null;
}

export const DEFAULT_PRE_BACKUP_TIMEOUT_SEC = 300;
export const MAX_PRE_BACKUP_TIMEOUT_SEC = 3600;

/** What Compose accepts as a service name. */
export const COMPOSE_SERVICE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function defaultBackupSettings(): ProjectBackupSettings {
  return { consistency: "pause", preBackup: null };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePreBackup(value: unknown): PreBackupCommand | null {
  if (!isObject(value)) return null;
  const { service, command, timeoutSec } = value;
  if (typeof service !== "string" || !COMPOSE_SERVICE_PATTERN.test(service)) return null;
  if (typeof command !== "string" || !command.trim()) return null;
  const timeout =
    typeof timeoutSec === "number" && Number.isInteger(timeoutSec) && timeoutSec > 0
      ? Math.min(timeoutSec, MAX_PRE_BACKUP_TIMEOUT_SEC)
      : DEFAULT_PRE_BACKUP_TIMEOUT_SEC;
  return { service, command, timeoutSec: timeout };
}

export function parseBackupSettings(raw: string | null | undefined): ProjectBackupSettings {
  const settings = defaultBackupSettings();
  if (!raw) return settings;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (!isObject(parsed)) return settings;

  if (parsed.consistency === "pause" || parsed.consistency === "live") {
    settings.consistency = parsed.consistency;
  }
  settings.preBackup = parsePreBackup(parsed.preBackup);
  return settings;
}
