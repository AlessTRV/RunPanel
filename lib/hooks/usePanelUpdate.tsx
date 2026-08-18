"use client";

import { createContext, useContext } from "react";
import { useResource } from "@/lib/hooks/useResource";
import type { UpdateStatus } from "@/lib/panel-update";

/**
 * Whether the panel has a new version, fetched once for the whole shell.
 *
 * A context rather than a hook each, for the reason `PollingProvider` gives
 * about itself: two components in the same layout want this — the banner, to
 * decide whether to appear, and the sidebar, to put a dot on the version — and
 * a fetch per consumer would mean two requests for one fact, forever, on every
 * page of the panel.
 *
 * Five minutes, because producing this answer costs a `git fetch` on the server
 * and the answer changes on a scale of days.
 */

const POLL_MS = 300_000;

interface Value {
  status: UpdateStatus | null;
  refresh: () => void;
}

const PanelUpdateContext = createContext<Value>({ status: null, refresh: () => {} });

export function PanelUpdateProvider({ children }: { children: React.ReactNode }) {
  const { data, refresh } = useResource<UpdateStatus>("/api/updates", { intervalMs: POLL_MS });
  return (
    <PanelUpdateContext.Provider value={{ status: data, refresh }}>
      {children}
    </PanelUpdateContext.Provider>
  );
}

export function usePanelUpdate(): Value {
  return useContext(PanelUpdateContext);
}
