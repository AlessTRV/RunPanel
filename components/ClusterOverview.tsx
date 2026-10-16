"use client";

import { Icon } from "@iconify/react";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useNode } from "@/lib/hooks/useNode";
import { TONE_DOT } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { MemberOverview } from "@/app/api/cluster/overview/route";

/**
 * Every server of the cluster in one row, with how many of the projects the
 * user can see there are running. Picking one selects it, like the selector
 * in the bar. Renders nothing in solo mode.
 */
export function ClusterOverview() {
  const { isSolo, selected, select } = useNode();
  const { data } = useResource<{ members: MemberOverview[] }>(isSolo ? null : "/api/cluster/overview", {
    intervalMs: usePollInterval(30_000),
  });
  if (isSolo || !data || data.members.length < 2) return null;

  return (
    <ul className="mb-6 flex gap-2 overflow-x-auto pb-1" aria-label="Server del cluster">
      {data.members.map((m) => {
        const active = m.id === selected;
        const tone = !m.reachable ? "danger" : m.total !== null && m.running === m.total ? "success" : "warning";
        return (
          <li key={m.id} className="shrink-0">
          <button
            type="button"
            onClick={() => select(m.id)}
            aria-pressed={active}
            className={cn(
              "border-border bg-surface hover:bg-surface-2 flex min-w-40 items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
              active && "border-accent/60 bg-accent/5"
            )}
          >
            <Icon icon={m.role === "node" ? "solar:server-2-linear" : "solar:server-2-bold-duotone"} width={18} className="text-muted shrink-0" aria-hidden />
            <div className="min-w-0">
              <div className="text-foreground truncate text-sm font-medium">
                {m.name}
                {m.self && <span className="text-muted font-normal"> (questo)</span>}
              </div>
              <div className="text-muted flex items-center gap-1.5 text-xs">
                <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} aria-hidden />
                {!m.reachable ? "non raggiungibile" : m.total === null ? "—" : `${m.running}/${m.total} in esecuzione`}
              </div>
            </div>
          </button>
          </li>
        );
      })}
    </ul>
  );
}
