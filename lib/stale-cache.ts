/**
 * Stale-while-revalidate around an expensive zero-argument reading.
 *
 * The panel polls: the diagnostics page every 30s, the health banner every 60s,
 * the autostart page every 15s. Each of those answers used to spawn between six
 * and ten child processes — `docker version`, `git --version`, `pm2 -v`,
 * `systemctl`, a port probe — for facts that change about once a month. With
 * two tabs open that is a permanent background load for no new information.
 *
 * The shape is lifted from `services/host-metrics.ts`, which already did this
 * for disk usage; this is the same thing written once so the other callers can
 * have it too.
 *
 * After the first reading nobody waits: a caller past the TTL gets the previous
 * value immediately and the refresh lands behind it. Concurrent callers share
 * one refresh rather than starting one each.
 *
 * Nobody waiting is the right default for a poll and the wrong one for a
 * button. "Ricontrolla" on the diagnostics page re-ran nothing for exactly that
 * reason: it asked the same way the poll does, so it was answered from the
 * cache the poll had just filled — same bytes back, nothing to re-render, no
 * error to show for it. `get({ fresh: true })` is the caller who pressed
 * something and is owed a reading taken now.
 */
export interface StaleCache<T> {
  /**
   * The value, served from cache while it is young enough.
   *
   * `fresh` takes a new reading and waits for it. Polls must not pass it —
   * avoiding exactly that is what this cache is for.
   */
  get(options?: { fresh?: boolean }): Promise<T>;
  /**
   * When the value now held was produced, or null when nothing is held.
   *
   * A re-check that finds everything unchanged looks precisely like a re-check
   * that never ran, so a page that offers one has to be able to say when the
   * reading it is showing was taken.
   */
  producedAt(): number | null;
  /** Drop what is held, so the next `get()` produces a fresh reading. */
  invalidate(): void;
}

export function staleWhileRevalidate<T>(
  produce: () => Promise<T>,
  ttlMs: number
): StaleCache<T> {
  let cached: { value: T; at: number } | null = null;
  let refreshing: Promise<T> | null = null;

  function refresh(): Promise<T> {
    if (!refreshing) {
      refreshing = produce()
        .then((value) => {
          cached = { value, at: Date.now() };
          return value;
        })
        .finally(() => {
          refreshing = null;
        });
    }
    return refreshing;
  }

  return {
    async get({ fresh = false } = {}) {
      // Asked for on purpose: take a reading and wait for it, however young the
      // held one is. What is held is deliberately NOT dropped first — everyone
      // else keeps being served instantly while this reading is taken, and a
      // failed one leaves the panel with the last answer it trusted rather than
      // with nothing. `refresh` already collapses concurrent callers, so an
      // impatient hand on the button is one reading, not one per click.
      if (fresh) return refresh();

      if (cached && Date.now() - cached.at < ttlMs) return cached.value;

      const pending = refresh();

      // Nothing held yet — the first caller has to wait for a real reading.
      if (!cached) return pending;

      // Otherwise serve what we have. The handler matters: without it a failed
      // background refresh is an unhandled rejection, and on Node that is fatal.
      void pending.catch(() => {});
      return cached.value;
    },
    producedAt() {
      return cached ? cached.at : null;
    },
    invalidate() {
      cached = null;
    },
  };
}
