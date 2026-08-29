import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { createReporter } from "../harness.mjs";

/**
 * That a reading taken on demand is actually taken.
 *
 * `staleWhileRevalidate` exists because each of these readings spawns six to
 * ten child processes — `docker version`, `pm2 -v`, `systemctl`, a port probe —
 * for facts that change about once a month, and three pages poll for them. It
 * does that job well, and it did it to the one caller that must not be served
 * from cache: the "Ricontrolla" button on the diagnostics page.
 *
 * Pressing it re-ran nothing. The request went out, the route answered from the
 * 30s cache, and — because the poll had just filled that cache — the bytes came
 * back identical, so the page did not even re-render. No error, no toast, no
 * failed request: the same shape as the switches that rendered perfectly and
 * had nowhere to land. A control that cannot fail is not the same as one that
 * works.
 *
 * `get({ fresh: true })` is the button, and the checks below are its contract:
 * it re-runs the producer, it resolves to the NEW reading rather than the stale
 * one the other callers are still being served, and several impatient clicks
 * share a single run rather than starting a process storm each.
 *
 * `producedAt()` is the other half. A re-check that changes nothing looks
 * exactly like a re-check that never happened, so the page has to be able to
 * say WHEN the reading it is showing was taken.
 */
export const meta = { name: "stale-cache-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("stale-cache-unit");

  const { staleWhileRevalidate } = await import(
    pathToFileURL(join(repoRoot, "lib", "stale-cache.ts")).href
  );

  /** A producer that says how many times it has been asked. */
  function counted(delayMs = 0) {
    const state = { runs: 0 };
    const produce = async () => {
      state.runs++;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return `reading ${state.runs}`;
    };
    return [produce, state];
  }

  // --- the cache doing its job ---------------------------------------------
  {
    const [produce, state] = counted();
    const cache = staleWhileRevalidate(produce, 30_000);

    r.check("the first reading is produced", (await cache.get()) === "reading 1");
    await cache.get();
    await cache.get();
    r.check("polls inside the TTL cost nothing", state.runs === 1, `runs=${state.runs}`);
  }

  // --- the trap, pinned as a fact ------------------------------------------
  {
    const [produce, state] = counted();
    const cache = staleWhileRevalidate(produce, 30_000);

    await cache.get();
    const again = await cache.get();
    r.check(
      "a re-check that does not ask for a fresh reading gets the old one",
      again === "reading 1" && state.runs === 1,
      `${again} runs=${state.runs}`
    );
  }

  // --- the button ----------------------------------------------------------
  {
    const [produce, state] = counted();
    const cache = staleWhileRevalidate(produce, 30_000);

    await cache.get();
    const fresh = await cache.get({ fresh: true });

    r.check("a forced reading re-runs the producer", state.runs === 2, `runs=${state.runs}`);
    r.check(
      "a forced reading resolves to the new value, not the stale one",
      fresh === "reading 2",
      fresh
    );
    r.check("the new reading is what later callers get", (await cache.get()) === "reading 2");
    r.check("and it did not cost a third run", state.runs === 2, `runs=${state.runs}`);
  }

  // --- an impatient operator -----------------------------------------------
  {
    const [produce, state] = counted(20);
    const cache = staleWhileRevalidate(produce, 30_000);

    await cache.get();
    const [a, b, c] = await Promise.all([
      cache.get({ fresh: true }),
      cache.get({ fresh: true }),
      cache.get({ fresh: true }),
    ]);

    r.check(
      "three clicks in a row share one run",
      state.runs === 2,
      `runs=${state.runs} — one per reading, not one per click`
    );
    r.check("and all three see the same new reading", a === b && b === c && a === "reading 2", a);
  }

  // --- when the reading was taken ------------------------------------------
  {
    const [produce] = counted();
    const cache = staleWhileRevalidate(produce, 30_000);

    r.check("nothing held yet reports no reading", cache.producedAt() === null, cache.producedAt());

    const before = Date.now();
    await cache.get();
    const first = cache.producedAt();
    r.check("the first reading is timed", first !== null && first >= before, first);

    await cache.get();
    r.check("a cached answer does not move the clock", cache.producedAt() === first);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await cache.get({ fresh: true });
    r.check("a forced reading does", cache.producedAt() > first, `${cache.producedAt()} vs ${first}`);
  }

  // --- invalidate, which mutations use -------------------------------------
  {
    const [produce, state] = counted();
    const cache = staleWhileRevalidate(produce, 30_000);

    await cache.get();
    cache.invalidate();
    r.check("invalidate drops the timestamp too", cache.producedAt() === null);
    r.check("the next reading is a real one", (await cache.get()) === "reading 2", `runs=${state.runs}`);
  }

  // --- a failed reading -----------------------------------------------------
  {
    let runs = 0;
    const cache = staleWhileRevalidate(async () => {
      runs++;
      if (runs === 2) throw new Error("docker went away");
      return `reading ${runs}`;
    }, 30_000);

    await cache.get();
    let threw = false;
    try {
      await cache.get({ fresh: true });
    } catch {
      threw = true;
    }

    r.check("a forced reading that fails says so rather than lying", threw);
    r.check("and the next one recovers", (await cache.get({ fresh: true })) === "reading 3");
  }

  return r.result();
}
