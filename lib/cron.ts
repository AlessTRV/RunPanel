/**
 * A five-field cron parser and scheduler, written here rather than depended on.
 *
 * It lives in `lib/` and not next to the backup engine because two very
 * different callers need it: the validation schemas, which run in a request,
 * and the scheduler tick, which runs in the background. It has no imports at
 * all, which also lets the unit suite drive it directly.
 *
 * Supported: `*`, `n`, `a-b`, `*∕s`, `a-b/s`, comma lists, month names and
 * weekday names, and the `@daily` family of aliases. Not supported, and said so
 * in the UI: seconds, `L`, `W`, `#`, and `@reboot`.
 */

export interface CronSpec {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 = Sunday. A trailing 7 is folded onto 0 when parsing. */
  daysOfWeek: ReadonlySet<number>;
  /** Whether the field was narrowed from `*` — this is what makes the OR rule apply. */
  domRestricted: boolean;
  dowRestricted: boolean;
  /** The expression as given, aliases not expanded. */
  source: string;
}

export type CronParseResult = { ok: true; spec: CronSpec } | { ok: false; error: string };

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const DAY_LABELS = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const MONTH_LABELS = [
  "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
  "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
];

interface FieldSpec {
  min: number;
  max: number;
  names?: string[];
  label: string;
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59, label: "minuti" },
  { min: 0, max: 23, label: "ore" },
  { min: 1, max: 31, label: "giorno del mese" },
  { min: 1, max: 12, names: MONTH_NAMES, label: "mese" },
  { min: 0, max: 7, names: DAY_NAMES, label: "giorno della settimana" },
];

function parseValue(token: string, field: FieldSpec): number | null {
  const lower = token.toLowerCase();
  if (field.names) {
    const index = field.names.indexOf(lower);
    if (index >= 0) return field.min === 1 ? index + 1 : index;
  }
  if (!/^\d+$/.test(token)) return null;
  const value = Number(token);
  if (value < field.min || value > field.max) return null;
  return value;
}

function parseField(raw: string, field: FieldSpec): { values: Set<number>; restricted: boolean } | string {
  const values = new Set<number>();
  let restricted = false;

  for (const item of raw.split(",")) {
    if (item === "") return `Campo ${field.label} vuoto`;

    const [rangePart, stepPart] = item.split("/");
    if (item.split("/").length > 2) return `Passo non valido in "${item}" (${field.label})`;

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
        return `Passo non valido in "${item}" (${field.label})`;
      }
      step = Number(stepPart);
      restricted = true;
    }

    let start: number;
    let end: number;

    if (rangePart === "*") {
      start = field.min;
      end = field.max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      const from = parseValue(a, field);
      const to = parseValue(b, field);
      if (from === null || to === null) return `Valore non valido in "${item}" (${field.label})`;
      if (from > to) return `Intervallo al contrario in "${item}" (${field.label})`;
      start = from;
      end = to;
      restricted = true;
    } else {
      const only = parseValue(rangePart, field);
      if (only === null) return `Valore non valido in "${item}" (${field.label})`;
      start = only;
      end = stepPart === undefined ? only : field.max;
      restricted = true;
    }

    for (let v = start; v <= end; v += step) values.add(v);
  }

  if (values.size === 0) return `Campo ${field.label} senza valori`;
  return { values, restricted };
}

export function parseCron(expression: string): CronParseResult {
  const source = expression.trim();
  if (!source) return { ok: false, error: "Espressione vuota" };

  if (source.toLowerCase() === "@reboot") {
    return {
      ok: false,
      error:
        "@reboot non è una pianificazione: per far ripartire qualcosa all'avvio della macchina usa la pagina Avvio automatico",
    };
  }

  const expanded = source.startsWith("@") ? ALIASES[source.toLowerCase()] : source;
  if (!expanded) return { ok: false, error: `Alias sconosciuto: ${source}` };

  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `Servono 5 campi (minuto ora giorno mese giorno-settimana), ne ho trovati ${parts.length}`,
    };
  }

  const parsed = parts.map((part, i) => parseField(part, FIELDS[i]));
  const firstError = parsed.find((p): p is string => typeof p === "string");
  if (firstError) return { ok: false, error: firstError };

  const [minute, hour, dom, month, dow] = parsed as { values: Set<number>; restricted: boolean }[];

  // 7 and 0 are both Sunday. Folding here means every consumer can assume 0-6.
  const daysOfWeek = new Set<number>();
  for (const d of dow.values) daysOfWeek.add(d === 7 ? 0 : d);

  return {
    ok: true,
    spec: {
      minutes: minute.values,
      hours: hour.values,
      daysOfMonth: dom.values,
      months: month.values,
      daysOfWeek,
      domRestricted: dom.restricted,
      dowRestricted: dow.restricted,
      source,
    },
  };
}

// --- Time zones, without a library -----------------------------------------

interface WallTime {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  /** 0 = Sunday */
  dow: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = partsCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    partsCache.set(timeZone, cached);
  }
  return cached;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function wallTime(instant: number, timeZone: string): WallTime {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday").toLowerCase().slice(0, 3);
  return {
    y: Number(get("year")),
    mo: Number(get("month")),
    d: Number(get("day")),
    // "24" is how en-US with hour12:false spells midnight.
    h: Number(get("hour")) % 24,
    mi: Number(get("minute")),
    dow: Math.max(0, DAY_NAMES.indexOf(weekday)),
  };
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
function offsetAt(instant: number, timeZone: string): number {
  const local = wallTime(instant, timeZone);
  const asUtc = Date.UTC(local.y, local.mo - 1, local.d, local.h, local.mi);
  // Round to the minute: the instant carries seconds the wall time does not.
  return asUtc - Math.floor(instant / 60_000) * 60_000;
}

function compareWall(a: WallTime, y: number, mo: number, d: number, h: number, mi: number): number {
  return (
    a.y - y || a.mo - mo || a.d - d || a.h - h || a.mi - mi
  );
}

/**
 * A wall-clock time in a zone, as an instant.
 *
 * Twice a year this is not a function. Both cases are decided here rather than
 * left to whatever the arithmetic happens to produce:
 *
 *  - **Ambiguous** (clocks went back, the time happens twice) — the *earlier*
 *    instant. The later one would silently be a second run of the same
 *    scheduled minute.
 *  - **Non-existent** (clocks went forward, the time is inside the gap) — the
 *    first instant that does exist, which is the transition itself. 02:30
 *    becomes 03:00 rather than the night being skipped, because a nightly
 *    backup that quietly does not happen once a year is the whole problem.
 */
function wallToInstant(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string
): { instant: number; exact: boolean } {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);

  // Sample the offset on either side too: on a transition day the two candidate
  // offsets are what bracket the answer, and only one of them round-trips.
  const offsets = new Set([
    offsetAt(asUtc, timeZone),
    offsetAt(asUtc - 86_400_000, timeZone),
    offsetAt(asUtc + 86_400_000, timeZone),
  ]);

  const valid: number[] = [];
  for (const offset of offsets) {
    const candidate = asUtc - offset;
    if (compareWall(wallTime(candidate, timeZone), y, mo, d, h, mi) === 0) valid.push(candidate);
  }
  if (valid.length > 0) return { instant: Math.min(...valid), exact: true };

  const candidates = [...offsets].map((offset) => asUtc - offset);
  let lo = Math.min(...candidates);
  let hi = Math.max(...candidates);
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (mid <= lo) break;
    if (compareWall(wallTime(mid, timeZone), y, mo, d, h, mi) >= 0) hi = mid;
    else lo = mid;
  }
  return { instant: hi, exact: false };
}

function dayMatches(spec: CronSpec, wall: { mo: number; d: number; dow: number }): boolean {
  if (!spec.months.has(wall.mo)) return false;

  const domHit = spec.daysOfMonth.has(wall.d);
  const dowHit = spec.daysOfWeek.has(wall.dow);

  // The rule everyone gets wrong, and the reason `0 0 13 * 5` means "the 13th
  // OR any Friday" rather than "Friday the 13th": when both day fields are
  // narrowed, cron ORs them. When only one is, the other is `*` and matches
  // anything, so a plain AND gives the same answer.
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit;
  return domHit && dowHit;
}

const MAX_DAYS_AHEAD = 366 * 4;

/**
 * The first instant strictly after `from` that matches, or null if the
 * expression cannot fire within four years — which only a February 30th can.
 */
export function nextAfter(spec: CronSpec, from: Date, timeZone = "UTC"): Date | null {
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const fromMs = from.getTime();

  const hours = [...spec.hours].sort((a, b) => a - b);
  const minutes = [...spec.minutes].sort((a, b) => a - b);

  const start = wallTime(fromMs, zone);
  let cursor = Date.UTC(start.y, start.mo - 1, start.d);

  for (let day = 0; day < MAX_DAYS_AHEAD; day++) {
    const date = new Date(cursor);
    const y = date.getUTCFullYear();
    const mo = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    // The weekday of a calendar date is the same in every zone, so it can come
    // from plain UTC arithmetic instead of another Intl round trip.
    const dow = date.getUTCDay();

    if (dayMatches(spec, { mo, d, dow })) {
      for (const h of hours) {
        for (const mi of minutes) {
          const { instant } = wallToInstant(y, mo, d, h, mi, zone);
          if (instant > fromMs) return new Date(instant);
        }
      }
    }

    cursor += 86_400_000;
  }

  return null;
}

/** Convenience for the editor's "next three runs" preview. */
export function nextOccurrences(
  expression: string,
  from: Date,
  timeZone: string,
  count: number
): Date[] {
  const parsed = parseCron(expression);
  if (!parsed.ok) return [];

  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = nextAfter(parsed.spec, cursor, timeZone);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

// --- Describing an expression in words --------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function listLabel(values: number[], labels: string[], offset = 0): string {
  const named = values.map((v) => labels[v - offset] ?? String(v));
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(", ")} e ${named[named.length - 1]}`;
}

function isEvery(values: ReadonlySet<number>, min: number, max: number): boolean {
  return values.size === max - min + 1;
}

/** Step detection good enough for the shapes the UI actually offers. */
function stepOf(values: ReadonlySet<number>, min: number, max: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 2 || sorted[0] !== min) return null;
  const step = sorted[1] - sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] !== step) return null;
  }
  return sorted[sorted.length - 1] + step > max ? step : null;
}

/**
 * The expression in Italian, for the schedule list and the editor preview.
 *
 * It covers the shapes people actually write and falls back to the raw
 * expression otherwise — a wrong description would be worse than none.
 */
export function describeCron(expression: string): string {
  const parsed = parseCron(expression);
  if (!parsed.ok) return expression;

  const spec = parsed.spec;
  const everyMinute = isEvery(spec.minutes, 0, 59);
  const everyHour = isEvery(spec.hours, 0, 23);
  const everyDom = !spec.domRestricted;
  const everyMonth = isEvery(spec.months, 1, 12);
  const everyDow = !spec.dowRestricted;

  // A clock time reads best as a suffix ("ogni lunedì alle 03:00"); a recurring
  // interval reads best first ("ogni 15 minuti, solo di lunedì").
  let when: string;
  let isClockTime = false;

  if (everyMinute && everyHour) {
    when = "ogni minuto";
  } else if (everyHour && spec.minutes.size === 1) {
    when = `ogni ora al minuto ${pad([...spec.minutes][0])}`;
  } else if (everyHour) {
    const step = stepOf(spec.minutes, 0, 59);
    if (!step) return expression;
    when = `ogni ${step} minuti`;
  } else if (spec.minutes.size === 1) {
    const minute = pad([...spec.minutes][0]);
    const hours = [...spec.hours].sort((a, b) => a - b);
    const step = stepOf(spec.hours, 0, 23);
    if (hours.length === 1) {
      when = `alle ${pad(hours[0])}:${minute}`;
      isClockTime = true;
    } else if (step) {
      when = `ogni ${step} ore al minuto ${minute}`;
    } else if (hours.length <= 4) {
      when = `alle ${hours.map((h) => `${pad(h)}:${minute}`).join(", ")}`;
      isClockTime = true;
    } else {
      return expression;
    }
  } else {
    return expression;
  }

  const days = [...spec.daysOfWeek].sort((a, b) => a - b);
  const dates = [...spec.daysOfMonth].sort((a, b) => a - b);

  let dayPrefix = "ogni giorno";
  let daySuffix = "";
  if (!everyDow && !everyDom) {
    // Both narrowed: cron ORs them, and the wording has to say so or it lies.
    dayPrefix = `il giorno ${dates.join(", ")} del mese oppure di ${listLabel(days, DAY_LABELS)}`;
    daySuffix = `solo ${dayPrefix}`;
  } else if (!everyDow) {
    dayPrefix = `ogni ${listLabel(days, DAY_LABELS)}`;
    daySuffix = `solo di ${listLabel(days, DAY_LABELS)}`;
  } else if (!everyDom) {
    dayPrefix = `il giorno ${dates.join(", ")} di ogni mese`;
    daySuffix = `solo il giorno ${dates.join(", ")} del mese`;
  }

  const months = everyMonth
    ? ""
    : `, a ${listLabel([...spec.months].sort((a, b) => a - b), MONTH_LABELS, 1)}`;

  if (isClockTime) return `${dayPrefix} ${when}${months}`;
  return daySuffix ? `${when}, ${daySuffix}${months}` : `${when}${months}`;
}
