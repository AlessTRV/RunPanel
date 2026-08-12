/**
 * Sizes, durations and dates, in one place.
 *
 * There were fourteen implementations of these six functions. Not variants for
 * different needs — the same job, written again because the previous one was in
 * a file nobody thought to import from. Six for bytes alone, three of them
 * byte-identical under three different names, and one in the file manager that
 * had no MB step at all, so a 5 MB file read "5000K".
 *
 * The cost was never the duplication. It was that they DISAGREED: the same
 * number rendered differently depending on which screen showed it, and three
 * relative-time functions used three different granularities, so "when did this
 * happen" was answered in three vocabularies inside one app.
 *
 * No Node imports here, deliberately: client components import this.
 */

/**
 * `Intl` with an undefined locale resolves differently on the server than in
 * the browser, which is a hydration mismatch waiting to happen. Everything that
 * formats a date here is called from client components after data has loaded —
 * keep it that way, or pass an explicit locale.
 */
const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Nothing to show. One dash everywhere, rather than "", "—", "N/A" and "0". */
const NONE = "—";

/**
 * Bytes as people read them.
 *
 * Binary units, because that is what `docker system df` and every filesystem
 * tool on the host report — a panel that disagreed with them by 7% would look
 * wrong rather than precise.
 *
 * Accepts undefined so it can absorb the two divergent behaviours it replaces:
 * the monitor's `fmtMem` returned a dash for anything falsy, storage returned
 * "0 B". Zero is a real measurement and reads as "0 B"; absent reads as a dash.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return NONE;
  if (!Number.isFinite(bytes) || bytes < 0) return NONE;
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** How long something has been up. Two units, never three — "2g 4h", not "2g 4h 13m". */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return NONE;
  if (!Number.isFinite(seconds) || seconds < 0) return NONE;

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}g ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** How long something took. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return NONE;
  if (!Number.isFinite(ms) || ms < 0) return NONE;
  if (ms < 1000) return `${Math.round(ms)} ms`;

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * The same, for the common case of two timestamps.
 *
 * A separate function rather than a second signature: a deploy that is still
 * running has no end, and the caller reading `finished_at ?? null` should get a
 * dash rather than a duration measured against the epoch.
 */
export function formatDurationBetween(
  from: string | null | undefined,
  to: string | null | undefined
): string {
  if (!from || !to) return NONE;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return NONE;
  return formatDuration(end - start);
}

/** An absolute date, short. "12 ago, 14:30". */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return NONE;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NONE;
  return DATE_TIME.format(date);
}

/**
 * "3 minuti fa", "tra 6 ore" — the form that answers "is this recent?".
 *
 * The canonical one is the version that also handles FUTURE instants, because
 * the backup screens need it for the next scheduled run and the two versions
 * that only looked backwards would have rendered it as "0 minuti fa".
 *
 * Words, not abbreviations: the session list used to say "3g fa" and the app
 * form "3 giorni fa" for the same interval.
 */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "mai";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "mai";

  const deltaMs = then - Date.now();
  const future = deltaMs > 0;
  const seconds = Math.abs(deltaMs) / 1000;

  const say = (value: number, unit: string, plural: string) => {
    const rounded = Math.round(value);
    const noun = rounded === 1 ? unit : plural;
    return future ? `tra ${rounded} ${noun}` : `${rounded} ${noun} fa`;
  };

  if (seconds < 60) return future ? "tra pochi secondi" : "pochi secondi fa";
  if (seconds < 3600) return say(seconds / 60, "minuto", "minuti");
  if (seconds < 86_400) return say(seconds / 3600, "ora", "ore");
  return say(seconds / 86_400, "giorno", "giorni");
}
