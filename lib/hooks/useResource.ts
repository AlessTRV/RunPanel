"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  /** Milliseconds between refreshes. 0 disables polling entirely. */
  intervalMs?: number;
  enabled?: boolean;
  /**
   * Where a manual `refresh()` should go, when asking for an answer computed
   * now is a different request from the cheap one the poll makes.
   *
   * `/api/diagnostics` is the case this exists for: polls take the 30s cache,
   * `?fresh=1` re-runs the checks.
   */
  refreshUrl?: string;
}

interface Result<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Resolves once the refresh has landed, so a caller can await it. */
  refresh: () => Promise<void>;
  /** True while a manual refresh is in flight — the button's pending state. */
  refreshing: boolean;
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
 *
 * That last one is why a manual refresh is not just another poll here. Both
 * guards are silent by design — a tick that arrives mid-request is dropped, a
 * response identical to the last one is not published — and silence is the
 * right answer for something nobody asked for. Behind a button it is the wrong
 * one: the diagnostics page's "Ricontrolla" could be swallowed by a poll that
 * happened to be in flight, and when it did get through it published nothing,
 * because it had asked the same cache the same question. So `refresh()` is
 * never dropped for a poll, it can go somewhere else than the poll does
 * (`refreshUrl`), and it reports itself through `refreshing` — a control the
 * operator pressed has to visibly do something, even when the answer is that
 * nothing changed.
 */
export function useResource<T>(url: string | null, options: Options = {}): Result<T> {
  const { intervalMs = 0, enabled = true, refreshUrl } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url) && enabled);
  const [refreshing, setRefreshing] = useState(false);

  const inFlight = useRef(false);
  /** Tracked apart from the poll's, so neither can swallow the other. */
  const manualInFlight = useRef(false);
  const generation = useRef(0);
  /** Serialised last payload. Null until the first response arrives. */
  const published = useRef<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal, manual = false) => {
      if (!url) return Promise.resolve();

      // A poll never stacks on a poll. A manual refresh is not held to that:
      // it used to be dropped by whichever background tick happened to be
      // running, which is the one moment an operator is watching for a result.
      // `refresh` below is what keeps a press from stacking on itself.
      if (!manual && inFlight.current) return Promise.resolve();
      if (!manual) inFlight.current = true;

      const mine = ++generation.current;

      return fetch(manual ? (refreshUrl ?? url) : url, { signal })
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
          if (!manual) inFlight.current = false;
        });
    },
    [url, refreshUrl]
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

  /**
   * The press.
   *
   * It owns the pending state rather than `load` doing it, and that is not
   * bookkeeping: `load` runs from the polling effect, and a setState reached
   * synchronously from there is a cascading render — the lint rule that says so
   * is right. The press is also where "not twice at once" belongs, since it is
   * the only caller a human can repeat by hand.
   *
   * No abort signal: a refresh belongs to the press, not to the effect, and
   * cancelling it because the cadence changed underneath would put the button
   * back to doing nothing at random.
   */
  const refresh = useCallback(() => {
    if (!url || manualInFlight.current) return Promise.resolve();
    manualInFlight.current = true;
    setRefreshing(true);

    return load(undefined, true).finally(() => {
      manualInFlight.current = false;
      setRefreshing(false);
    });
  }, [url, load]);

  return { data, error, loading, refresh, refreshing };
}
