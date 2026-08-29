import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * "Ricontrolla", end to end.
 *
 * The button on the diagnostics page rendered, was pressable, fired its handler
 * and sent its request — and re-ran nothing. `/api/diagnostics` answered every
 * caller from a 30s cache, including the one caller that exists to bypass it,
 * and since the page's own poll had just filled that cache the response came
 * back byte-identical: no re-render, no toast, no failed request. A control
 * that cannot fail is not the same as a control that works, and nothing in the
 * type system, the build or a screenshot can tell those two apart.
 *
 * So the thing asserted here is the one that separates them: whether the
 * reading the panel hands back was taken before or after the press. That is
 * what `checkedAt` is for, and it is checked from outside, over HTTP, against a
 * real server — `stale-cache-unit` covers the mechanism underneath in
 * milliseconds, but only this can say the route is wired to it.
 */
export const meta = { name: "diagnostics", needsDocker: false, drivers: ["sqlite"] };

export async function run({ base }) {
  const r = createReporter("diagnostics");

  const api = client(base);
  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "diagnostics-pw-1" }),
  });

  // A parameter that spawns a dozen child processes is not one to leave open.
  const anonymous = client(base);
  const guarded = await anonymous.call("/api/diagnostics?fresh=1");
  r.check("a forced reading still needs a session", guarded.status === 401, guarded.status);

  // --- what a page load gets -----------------------------------------------
  const first = await api.call("/api/diagnostics");
  r.check("the checks answer", first.status === 200, first.status);
  r.check(
    "and there are some",
    Array.isArray(first.body.checks) && first.body.checks.length > 0,
    JSON.stringify(first.body).slice(0, 200)
  );
  r.check(
    "the reading says when it was taken",
    Number.isFinite(Date.parse(first.body.checkedAt)),
    first.body.checkedAt
  );

  // --- what the poll gets ---------------------------------------------------
  const polled = await api.call("/api/diagnostics");
  r.check(
    "a poll inside the TTL is served from cache",
    polled.body.checkedAt === first.body.checkedAt,
    `${polled.body.checkedAt} vs ${first.body.checkedAt}`
  );

  // --- what the button gets -------------------------------------------------
  const rechecked = await api.call("/api/diagnostics?fresh=1");
  r.check(
    "Ricontrolla takes a reading of its own",
    Date.parse(rechecked.body.checkedAt) > Date.parse(first.body.checkedAt),
    `${rechecked.body.checkedAt} vs ${first.body.checkedAt}`
  );
  r.check(
    "and a complete one",
    rechecked.body.checks.length === first.body.checks.length,
    `${rechecked.body.checks.length} vs ${first.body.checks.length}`
  );
  r.check(
    "the page can tell something happened",
    JSON.stringify(rechecked.body) !== JSON.stringify(first.body),
    "identical payloads are dropped by useResource, which is how this looked dead"
  );

  const after = await api.call("/api/diagnostics");
  r.check(
    "and the new reading is what the polls see from then on",
    after.body.checkedAt === rechecked.body.checkedAt,
    `${after.body.checkedAt} vs ${rechecked.body.checkedAt}`
  );

  return r.result();
}
