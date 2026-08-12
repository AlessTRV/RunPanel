"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  /** Milliseconds between refreshes. 0 disables polling entirely. */
  intervalMs?: number;
  enabled?: boolean;
}

interface Result<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Fetch-and-refresh for the pages that still poll.
 *
 * Two things every hand-rolled poller in this codebase got wrong:
 *
 *  - it kept polling while the tab was in the background. A dashboard left open
 *    on a second monitor was hitting the server every few seconds forever, and
 *    on this panel each of those requests shells out to docker or pm2.
 *  - it had no in-flight guard, so a slow response overlapped the next tick and
 *    responses could land out of order.
 *
 * Both are handled here once instead of in every page.
 *
 * A third one is handled here too: a poll that returns the same data no longer
 * publishes it. `setData` on every tick meant a new object identity every few
 * seconds, so the whole page re-rendered while nothing had changed — and every
 * `memo()` on a row component was dead weight, since its prop was never the
 * same object twice.
 */
export function useResource<T>(url: string | null, options: Options = {}): Result<T> {
  const { intervalMs = 0, enabled = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url) && enabled);

  const inFlight = useRef(false);
  const generation = useRef(0);
  /** Serialised last payload. Null until the first response arrives. */
  const published = useRef<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) => {
      if (!url || inFlight.current) return Promise.resolve();
      inFlight.current = true;
      const mine = ++generation.current;

      return fetch(url, { signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as T;
        })
        .then((json) => {
          // Ignore a response that a newer request has already superseded.
          if (mine !== generation.current) return;

          // Only hand out a new object when the bytes actually differ. The
          // comparison costs a stringify of a few KB; the re-render it avoids
          // costs the whole subtree.
          const serialized = JSON.stringify(json);
          if (serialized !== published.current) {
            published.current = serialized;
            setData(json);
          }

          // React bails out when the value is unchanged, so these are free on
          // a poll that changed nothing.
          setError(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (mine !== generation.current) return;
          setError(err instanceof Error ? err.message : "Request failed");
          setLoading(false);
        })
        .finally(() => {
          inFlight.current = false;
        });
    },
    [url]
  );

  useEffect(() => {
    if (!url || !enabled) return;

    // `loading` was derived once, on first render. A url that only becomes
    // known later — a tab that mounts before its id is resolved — then showed
    // the empty state instead of the skeleton while its first request ran.
    if (published.current === null) setLoading(true);

    const controller = new AbortController();
    load(controller.signal);

    if (intervalMs <= 0) return () => controller.abort();

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => load(controller.signal), intervalMs);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        // Catch up immediately on return, then resume the cadence.
        load(controller.signal);
        start();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
    };
  }, [url, enabled, intervalMs, load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { data, error, loading, refresh };
}
