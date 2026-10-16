"use client";

import { createContext, useContext, useMemo } from "react";
import { useResource } from "@/lib/hooks/useResource";
import { useCan } from "@/lib/hooks/useMe";
import { useNode } from "@/lib/hooks/useNode";
import { hasUpdate, isUpdateActive, type UpdateStatus } from "@/lib/panel-update";
import type { PerServer } from "@/lib/cluster-merge";

/**
 * Whether the panel has a new version, fetched once for the whole shell.
 *
 * A context rather than a hook each, for the reason `PollingProvider` gives
 * about itself: two components in the same layout want this — the banner, to
 * decide whether to appear, and the sidebar, to put a dot on the version — and
 * a fetch per consumer would mean two requests for one fact, forever, on every
 * page of the panel.
 *
 * In a cluster it asks every server, and `status` is the one that matters
 * most: a server updating now, else one with an update waiting, else the
 * server the page is about. `pending` names every server with an update.
 *
 * Five minutes, because producing this answer costs a `git fetch` on the server
 * and the answer changes on a scale of days.
 */

const POLL_MS = 300_000;

interface Value {
  status: UpdateStatus | null;
  /** The server `status` belongs to; null in solo mode. */
  memberId: string | null;
  memberName: string;
  /** Servers with an update waiting or running. */
  pending: { memberId: string; memberName: string }[];
  refresh: () => void;
}

const PanelUpdateContext = createContext<Value>({ status: null, memberId: null, memberName: "", pending: [], refresh: () => {} });

export function PanelUpdateProvider({ children }: { children: React.ReactNode }) {
  // Only for accounts that may update the panel: the API refuses everyone else.
  const canUpdate = useCan("updates");
  const { isSolo, selected } = useNode();
  const solo = useResource<UpdateStatus>(canUpdate && isSolo ? "/api/updates" : null, { intervalMs: POLL_MS });
  const cluster = useResource<{ servers: PerServer<UpdateStatus>[] }>(canUpdate && !isSolo ? "/api/cluster/updates" : null, {
    intervalMs: POLL_MS,
  });

  const value = useMemo<Value>(() => {
    if (isSolo) return { status: solo.data, memberId: null, memberName: "", pending: [], refresh: () => void solo.refresh() };
    const servers = (cluster.data?.servers ?? []).filter((s) => s.data);
    const pending = servers.filter((s) => s.data && (isUpdateActive(s.data) || hasUpdate(s.data)));
    const pick =
      servers.find((s) => s.data && isUpdateActive(s.data)) ??
      pending[0] ??
      servers.find((s) => s.memberId === selected) ??
      servers[0] ??
      null;
    return {
      status: pick?.data ?? null,
      memberId: pick?.memberId ?? null,
      memberName: pick?.memberName ?? "",
      pending: pending.map((s) => ({ memberId: s.memberId, memberName: s.memberName })),
      refresh: () => void cluster.refresh(),
    };
  }, [isSolo, solo, cluster, selected]);

  return <PanelUpdateContext.Provider value={value}>{children}</PanelUpdateContext.Provider>;
}

export function usePanelUpdate(): Value {
  return useContext(PanelUpdateContext);
}
