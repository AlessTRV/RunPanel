"use client";

import { createContext, useContext, useEffect, useState } from "react";

/**
 * The refresh cadence the operator picked, made real.
 *
 * `polling_interval` was a fully built feature that did nothing: validated in
 * the settings route, saved to the database, rendered as a 2/5/10s control in
 * Account, read back on page load — and then ignored, because all thirteen
 * `intervalMs:` values in the panel were literals. The setting had a UI, a
 * round trip and no effect, which is worse than not having it: it is the panel
 * telling the operator something untrue about itself.
 *
 * A context rather than a fetch per hook: every polling page would otherwise
 * request the setting before it could start polling, which is a request to
 * learn how often to make requests.
 *
 * `scale` is the unit. A page asking for 5000ms is saying "the default
 * cadence", and gets 2000 or 10000 when the operator asked for those. A page
 * that polls on a different rhythm — the 3s monitor, the 20s targets list —
 * keeps its own proportion, because the choice is about how eager the panel
 * should be, not about one number.
 */

const DEFAULT_SECONDS = 5;

const PollingContext = createContext<number>(DEFAULT_SECONDS);

export function PollingProvider({ children }: { children: React.ReactNode }) {
  const [seconds, setSeconds] = useState(DEFAULT_SECONDS);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        const parsed = Number.parseInt(String(data.polling_interval ?? ""), 10);
        if (Number.isFinite(parsed) && parsed > 0) setSeconds(parsed);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return <PollingContext.Provider value={seconds}>{children}</PollingContext.Provider>;
}

/**
 * Scale a page's own cadence by the operator's choice.
 *
 * `usePollInterval(5000)` is the default rhythm; `usePollInterval(3000)` stays
 * proportionally quicker at every setting.
 */
export function usePollInterval(baseMs: number): number {
  const seconds = useContext(PollingContext);
  return Math.round((baseMs * seconds) / DEFAULT_SECONDS);
}
