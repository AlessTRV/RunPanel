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
 */
export interface StaleCache<T> {
  get(): Promise<T>;
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
    async get() {
      if (cached && Date.now() - cached.at < ttlMs) return cached.value;

      const pending = refresh();

      // Nothing held yet — the first caller has to wait for a real reading.
      if (!cached) return pending;

      // Otherwise serve what we have. The handler matters: without it a failed
      // background refresh is an unhandled rejection, and on Node that is fatal.
      void pending.catch(() => {});
      return cached.value;
    },
    invalidate() {
      cached = null;
    },
  };
}
