/**
 * How a project's volumes are backed up: what happens to their writers during
 * the copy, what runs before it, and what is left out of it.
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
  /**
   * Paths left out of each volume's copy, keyed by the Docker volume name.
   * Relative to the volume's root; each one takes everything below it along.
   */
  excludes: Record<string, string[]>;
}

export const DEFAULT_PRE_BACKUP_TIMEOUT_SEC = 300;
export const MAX_PRE_BACKUP_TIMEOUT_SEC = 3600;

/** What Compose accepts as a service name. */
export const COMPOSE_SERVICE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** What Docker accepts as a volume name. */
export const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export const MAX_EXCLUDES_PER_VOLUME = 50;

export const EXCLUDE_PATH_RULE =
  "Un percorso relativo alla radice del volume, es. trades o cache/tmp — niente \"..\", niente / iniziale, niente caratteri jolly";

/*
  Letters, digits, spaces and `._@+-`, per segment.

  Narrow on purpose. The path reaches `tar --exclude`, which reads it as a
  pattern, and the restore's `find -path`, which does too: with no wildcard and
  no quote allowed, the pattern and the literal path are the same thing, and
  the string can be single-quoted into a shell script without escaping.
*/
const SEGMENT = /^[\p{L}\p{N}._@+\- ]+$/u;

/**
 * `trades/`, `./trades` and `trades` are the same exclusion; `../x`, `/etc`
 * and `*.parquet` are none at all. Null when the input is not a path this
 * accepts.
 */
export function normalizeExcludePath(raw: string): string | null {
  let value = raw.trim();
  if (!value || value.length > 255 || value.startsWith("/")) return null;
  while (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/\/+$/, "");
  if (!value) return null;

  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || !SEGMENT.test(segment))) {
    return null;
  }
  return segments.join("/");
}

/** Valid, deduplicated, and capped — the form in which a list is stored and used. */
export function normalizeExcludeList(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const path = normalizeExcludePath(raw);
    if (path && !out.includes(path)) out.push(path);
    if (out.length >= MAX_EXCLUDES_PER_VOLUME) break;
  }
  return out;
}

export function excludesFor(settings: ProjectBackupSettings, volume: string): string[] {
  return settings.excludes[volume] ?? [];
}

export function defaultBackupSettings(): ProjectBackupSettings {
  return { consistency: "pause", preBackup: null, excludes: {} };
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

  if (isObject(parsed.excludes)) {
    for (const [volume, paths] of Object.entries(parsed.excludes)) {
      if (!VOLUME_NAME_PATTERN.test(volume) || !Array.isArray(paths)) continue;
      const list = normalizeExcludeList(paths.filter((path): path is string => typeof path === "string"));
      if (list.length > 0) settings.excludes[volume] = list;
    }
  }
  return settings;
}
