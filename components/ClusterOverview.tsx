"use client";

import { Icon } from "@iconify/react";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useNode } from "@/lib/hooks/useNode";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ServerCard } from "@/app/api/cluster/servers/route";

/**
 * Every server of the cluster at a glance: load, memory, disk, Docker,
 * version, projects, and what needs attention. Picking a card narrows the
 * page to that server; picking it again shows every server. Renders nothing in
 * solo mode.
 */
export function ClusterOverview({ className, interactive = true }: { className?: string; interactive?: boolean }) {
  const { isSolo, serverParam, select } = useNode();
  const { data } = useResource<{ servers: ServerCard[] }>(isSolo ? null : "/api/cluster/servers", {
    intervalMs: usePollInterval(15_000),
  });
  if (isSolo || !data || data.servers.length < 2) return null;

  return (
    <ul className={cn("mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3", className)} aria-label="Server del cluster">
      {data.servers.map((s) => (
        <li key={s.memberId}>
          <ServerCardView
            server={s}
            active={interactive && serverParam === s.memberId}
            onSelect={interactive ? () => select(serverParam === s.memberId ? null : s.memberId) : undefined}
          />
        </li>
      ))}
    </ul>
  );
}

export function ServerCardView({ server: s, active, onSelect }: { server: ServerCard; active?: boolean; onSelect?: () => void }) {
  const m = s.summary?.metrics;
  const worst = s.warnings[0]?.tone ?? null;
  const dot = !s.reachable ? "bg-danger" : worst === "danger" ? "bg-danger" : worst === "warn" ? "bg-warning" : "bg-success";

  const body = (
    <>
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden />
        <span className="text-foreground truncate font-medium">{s.memberName}</span>
        {s.self && <span className="text-muted text-xs">(questo)</span>}
        <span className="bg-default text-muted ml-auto rounded-md px-1.5 py-0.5 text-xs">{s.role === "node" ? "Nodo" : "Pannello"}</span>
      </div>

      {s.reachable && s.summary ? (
        <>
          {m ? (
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <Meter label="CPU" value={m.cpu} />
              <Meter label="Memoria" value={m.memory.total ? (m.memory.used / m.memory.total) * 100 : 0} />
              <Meter label="Disco" value={m.disk.total ? (m.disk.used / m.disk.total) * 100 : 0} />
            </div>
          ) : null}
          <div className="text-muted mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span>
              {s.summary.projects.running}/{s.summary.projects.total} progetti attivi
            </span>
            <span>
              {s.summary.services.running}/{s.summary.services.total} servizi
            </span>
            {m && <span>{formatBytes(m.disk.free)} liberi</span>}
            <span className="inline-flex items-center gap-1">
              <Icon icon="solar:box-linear" width={12} aria-hidden />
              Docker {s.summary.docker ? "ok" : "giù"}
            </span>
            {s.summary.version && <span className="font-mono">{s.summary.version}</span>}
          </div>
        </>
      ) : (
        <p className="text-danger mt-2 text-xs">{s.error ?? "Non raggiungibile"}</p>
      )}

      {s.warnings.filter((w) => w.kind !== "unreachable").length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {s.warnings
            .filter((w) => w.kind !== "unreachable")
            .map((w) => (
              <li
                key={w.kind}
                className={cn("rounded-md px-1.5 py-0.5 text-xs", w.tone === "danger" ? "bg-danger/10 text-danger" : "bg-warning/10 text-warning")}
              >
                {w.text}
              </li>
            ))}
        </ul>
      )}
    </>
  );

  if (!onSelect) return <div className="border-border bg-surface rounded-xl border p-4">{body}</div>;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "border-border bg-surface hover:bg-surface-2 w-full rounded-xl border p-4 text-left transition-colors",
        active && "border-accent/60 bg-accent/5"
      )}
    >
      {body}
    </button>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = pct > 90 ? "bg-danger" : pct > 75 ? "bg-warning" : "bg-accent";
  return (
    <div className="min-w-0">
      <div className="text-muted flex justify-between">
        <span>{label}</span>
        <span className="text-foreground pl-1 tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="bg-default mt-1 h-1.5 overflow-hidden rounded-full">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
