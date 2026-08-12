import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The cron parser, on its own — no server, no Docker, no database.
 *
 * This is the highest-value suite in the backup work, because every failure it
 * catches is silent in production: an expression that parses into the wrong set
 * fires at the wrong time, and a daylight-saving edge either skips a night or
 * runs a night twice. Neither shows up as an error anywhere.
 *
 * The DST dates below are Europe/Rome in 2026: forward on 29 March (02:00 →
 * 03:00) and back on 25 October (03:00 → 02:00).
 */
export const meta = { name: "cron", needsDocker: false, drivers: [], standalone: true };

const ROME = "Europe/Rome";

export async function run({ repoRoot }) {
  const r = createReporter("cron");

  const { parseCron, nextAfter, nextOccurrences, describeCron, isValidTimeZone } = await import(
    pathToFileURL(join(repoRoot, "lib", "cron.ts")).href
  );

  const spec = (expr) => {
    const parsed = parseCron(expr);
    if (!parsed.ok) throw new Error(`${expr}: ${parsed.error}`);
    return parsed.spec;
  };
  const next = (expr, from, tz = "UTC") => nextAfter(spec(expr), new Date(from), tz);
  const iso = (date) => (date ? date.toISOString() : null);

  // --- parsing -------------------------------------------------------------
  r.check("a plain expression parses", parseCron("0 3 * * *").ok);
  r.check(
    "minutes are exactly the listed ones",
    [...spec("0,30 * * * *").minutes].sort((a, b) => a - b).join(",") === "0,30"
  );
  r.check("a range expands", [...spec("0 9-11 * * *").hours].sort((a, b) => a - b).join(",") === "9,10,11");
  r.check("a step over a range expands", [...spec("0 0-12/6 * * *").hours].sort((a, b) => a - b).join(",") === "0,6,12");
  r.check("*/15 gives four minutes", spec("*/15 * * * *").minutes.size === 4);
  r.check("a bare value with a step runs to the end", [...spec("0 5/6 * * *").hours].join(",") === "5,11,17,23");
  r.check("month names work", spec("0 0 1 jan *").months.has(1) && spec("0 0 1 JAN *").months.size === 1);
  r.check("weekday names work", spec("0 0 * * mon").daysOfWeek.has(1));
  r.check("day 7 folds onto Sunday", spec("0 0 * * 7").daysOfWeek.has(0) && !spec("0 0 * * 7").daysOfWeek.has(7));

  for (const [expr, why] of [
    ["0 3 * *", "four fields"],
    ["0 3 * * * *", "six fields"],
    ["60 * * * *", "minute out of range"],
    ["0 24 * * *", "hour out of range"],
    ["0 0 0 * *", "day zero"],
    ["0 0 * 13 *", "month out of range"],
    ["0 0 * * 8", "weekday out of range"],
    ["0 11-9 * * *", "reversed range"],
    ["*/0 * * * *", "zero step"],
    ["0 3 * * mardi", "unknown name"],
    ["", "empty"],
    ["@nonesiste", "unknown alias"],
  ]) {
    r.check(`rejected: ${why}`, parseCron(expr).ok === false, expr);
  }

  const reboot = parseCron("@reboot");
  r.check(
    "@reboot is refused and points somewhere useful",
    reboot.ok === false && /Avvio automatico/.test(reboot.error),
    reboot.error
  );

  // --- aliases -------------------------------------------------------------
  r.check("@daily is midnight", iso(next("@daily", "2026-05-10T08:00:00Z")) === "2026-05-11T00:00:00.000Z");
  r.check("@hourly is on the hour", iso(next("@hourly", "2026-05-10T08:12:00Z")) === "2026-05-10T09:00:00.000Z");
  r.check("@monthly is the first", iso(next("@monthly", "2026-05-10T08:00:00Z")) === "2026-06-01T00:00:00.000Z");
  r.check("@weekly is Sunday", iso(next("@weekly", "2026-05-10T08:00:00Z")) === "2026-05-17T00:00:00.000Z");

  // --- the OR rule ---------------------------------------------------------
  // `0 0 13 * 5` is "the 13th OR any Friday", not "Friday the 13th". November
  // 2026 has both: Friday the 6th comes before the 13th.
  const orRule = next("0 0 13 * 5", "2026-11-01T00:00:00Z");
  r.check("both day fields narrowed means OR", iso(orRule) === "2026-11-06T00:00:00.000Z", iso(orRule));

  const domOnly = next("0 0 13 * *", "2026-11-01T00:00:00Z");
  r.check("only the day of month narrowed means AND with *", iso(domOnly) === "2026-11-13T00:00:00.000Z", iso(domOnly));

  const dowOnly = next("0 0 * * 5", "2026-11-01T00:00:00Z");
  r.check("only the weekday narrowed", iso(dowOnly) === "2026-11-06T00:00:00.000Z", iso(dowOnly));

  // --- time zones ----------------------------------------------------------
  r.check(
    "03:00 in Rome is 01:00Z in summer",
    iso(next("0 3 * * *", "2026-07-01T00:00:00Z", ROME)) === "2026-07-01T01:00:00.000Z"
  );
  r.check(
    "03:00 in Rome is 02:00Z in winter",
    iso(next("0 3 * * *", "2026-01-01T00:00:00Z", ROME)) === "2026-01-01T02:00:00.000Z"
  );
  r.check(
    "an unknown zone falls back to UTC instead of throwing",
    iso(next("0 3 * * *", "2026-07-01T00:00:00Z", "Mars/Olympus")) === "2026-07-01T03:00:00.000Z"
  );
  r.check("a real zone validates", isValidTimeZone(ROME) && !isValidTimeZone("Mars/Olympus"));

  // --- clocks forward: the night must not be skipped ------------------------
  // 02:30 does not exist on 29 March 2026 in Rome. The run happens at the first
  // instant that does, 03:00 local — 01:00Z — rather than being lost.
  const gap = next("30 2 * * *", "2026-03-28T12:00:00Z", ROME);
  r.check(
    "a non-existent local time runs at the first instant that exists",
    iso(gap) === "2026-03-29T01:00:00.000Z",
    iso(gap)
  );

  // The following day is ordinary again.
  const afterGap = next("30 2 * * *", "2026-03-29T01:00:00Z", ROME);
  r.check("the day after the gap is normal", iso(afterGap) === "2026-03-30T00:30:00.000Z", iso(afterGap));

  // --- clocks back: the slot must not run twice -----------------------------
  // 02:30 happens twice on 25 October 2026: at 00:30Z (+2) and again at 01:30Z
  // (+1). The first one wins, and the search from there lands on the next day.
  const ambiguous = next("30 2 * * *", "2026-10-24T12:00:00Z", ROME);
  r.check(
    "an ambiguous local time runs on the first occurrence",
    iso(ambiguous) === "2026-10-25T00:30:00.000Z",
    iso(ambiguous)
  );

  const afterAmbiguous = next("30 2 * * *", "2026-10-25T00:30:00Z", ROME);
  r.check(
    "the second occurrence is not a second run",
    iso(afterAmbiguous) === "2026-10-26T01:30:00.000Z",
    iso(afterAmbiguous)
  );

  // --- sequences -----------------------------------------------------------
  const series = nextOccurrences("*/15 * * * *", new Date("2026-05-10T08:07:00Z"), "UTC", 3).map(iso);
  r.check(
    "occurrences advance rather than repeating",
    series.join(" ") ===
      "2026-05-10T08:15:00.000Z 2026-05-10T08:30:00.000Z 2026-05-10T08:45:00.000Z",
    series.join(" ")
  );
  r.check("an invalid expression yields no occurrences", nextOccurrences("nope", new Date(), "UTC", 3).length === 0);

  r.check("a strictly-after search never returns its own input", iso(next("0 3 * * *", "2026-05-10T03:00:00Z")) === "2026-05-11T03:00:00.000Z");

  // --- a date that cannot happen -------------------------------------------
  r.check("30 February gives up instead of looping", next("0 0 30 2 *", "2026-01-01T00:00:00Z") === null);

  // --- leap day ------------------------------------------------------------
  r.check(
    "29 February is found in a leap year",
    iso(next("0 0 29 2 *", "2026-03-01T00:00:00Z")) === "2028-02-29T00:00:00.000Z"
  );

  // --- descriptions --------------------------------------------------------
  for (const [expr, expected] of [
    ["0 3 * * *", "ogni giorno alle 03:00"],
    ["@daily", "ogni giorno alle 00:00"],
    ["30 2 * * *", "ogni giorno alle 02:30"],
    ["0 0 * * 0", "ogni domenica alle 00:00"],
    ["0 4 * * 1,5", "ogni lunedì e venerdì alle 04:00"],
    ["@monthly", "il giorno 1 di ogni mese alle 00:00"],
    ["*/15 * * * *", "ogni 15 minuti"],
    ["0 * * * *", "ogni ora al minuto 00"],
    ["* * * * *", "ogni minuto"],
  ]) {
    const got = describeCron(expr);
    r.check(`described: ${expr}`, got === expected, `"${got}" (atteso "${expected}")`);
  }

  r.check(
    "an expression it cannot phrase is shown verbatim, never guessed",
    describeCron("7,13,42 1,2,9,17,23 * * *") === "7,13,42 1,2,9,17,23 * * *"
  );

  return r.result();
}
