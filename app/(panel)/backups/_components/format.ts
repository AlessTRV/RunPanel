/**
 * Dates and durations as the backup screens show them.
 *
 * All of it runs in the browser after the data has loaded, so the user's own
 * locale and zone are the right ones to use — and there is no server render to
 * disagree with.
 */

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return DATE_TIME.format(date);
}

/** "3 minuti fa", "tra 6 ore" — the form that answers "is this recent?". */
export function formatRelative(iso: string | null): string {
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

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** What a run was started by, in words. */
export function triggerLabel(trigger: string): string {
  if (trigger === "schedule") return "pianificato";
  if (trigger === "pre-restore") return "sicurezza pre-ripristino";
  return "manuale";
}
