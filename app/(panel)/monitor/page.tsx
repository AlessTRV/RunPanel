"use client";

import { memo, useCallback, useState } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { useResource } from "@/lib/hooks/useResource";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { statusMeta, TONE_DOT } from "@/lib/status";
import { cn } from "@/lib/utils";

interface ProcessInfo {
  running: boolean;
  pid?: number;
  memory?: number;
  cpu?: number;
  uptime?: number;
}

interface ServiceInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  port: number;
  uptime?: number;
  memory?: number;
  cpu?: number;
}

interface ProjectInfo {
  id: string;
  name: string;
  slug: string;
  runtimeType: string;
  status: string;
  port: number | null;
  process: ProcessInfo | null;
  services: ServiceInfo[];
}

interface MonitorData {
  server: { cpu: number; memory: { total: number; used: number }; uptime: number };
  projects: ProjectInfo[];
}

function fmtMem(bytes: number | undefined): string {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function fmtUptime(seconds: number | undefined): string {
  if (!seconds) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}g ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * One row, for a project or one of its services.
 *
 * A single responsive layout, not a desktop table plus a mobile card list. The
 * previous version rendered both and hid one with `hidden sm:block`, so every
 * row existed twice in the DOM and was re-rendered twice on every 3-second
 * poll.
 */
const Row = memo(function Row({
  label,
  sublabel,
  status,
  cpu,
  memory,
  uptime,
  href,
  nested,
  onToggle,
  collapsed,
}: {
  label: string;
  sublabel: string;
  status: string;
  cpu?: number;
  memory?: number;
  uptime?: number;
  href?: string;
  nested?: boolean;
  onToggle?: () => void;
  collapsed?: boolean;
}) {
  const meta = statusMeta(status);

  const content = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {onToggle && (
          <span className="text-muted shrink-0" aria-hidden>
            <Icon icon={collapsed ? "solar:alt-arrow-right-linear" : "solar:alt-arrow-down-linear"} width={14} />
          </span>
        )}
        <span
          className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[meta.tone], meta.active && "animate-pulse")}
          aria-hidden
        />
        <span className="text-foreground truncate text-sm">{label}</span>
        <span className="text-muted hidden truncate font-mono text-xs sm:inline">{sublabel}</span>
      </div>

      {/* Numbers stay on one line on every width: tabular figures and fixed
          columns, so the values do not jitter as they update. */}
      <div className="text-muted flex shrink-0 items-center gap-3 font-mono text-xs tabular-nums sm:gap-5">
        <span className="w-14 text-right" title="CPU">
          {cpu != null ? `${cpu.toFixed(1)}%` : "—"}
        </span>
        <span className="w-16 text-right" title="Memoria">
          {fmtMem(memory)}
        </span>
        <span className="hidden w-16 text-right sm:inline" title="Uptime">
          {fmtUptime(uptime)}
        </span>
      </div>
    </>
  );

  const className = cn(
    "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
    nested ? "pl-8" : "",
    (href || onToggle) && "hover:bg-surface-hover"
  );

  if (onToggle) {
    return (
      <button type="button" onClick={onToggle} className={className} aria-expanded={!collapsed}>
        {content}
      </button>
    );
  }

  if (href) {
    return (
      <Link href={href} className={className}>
        {content}
      </Link>
    );
  }

  return <div className={className}>{content}</div>;
});

export default function MonitorPage() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Polls, but stops while the tab is hidden — this endpoint inspects
  // containers, so an idle background tab was doing real work on the host
  // every three seconds forever.
  const { data, loading } = useResource<MonitorData>("/api/monitor", { intervalMs: 3000 });

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (loading && !data) return <PageSkeleton />;
  if (!data) return null;

  const memoryPercent = data.server.memory.total
    ? (data.server.memory.used / data.server.memory.total) * 100
    : 0;

  return (
    <>
      <PageHeader title="Monitor" description="Processi e servizi in esecuzione su questo host" />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatTile label="CPU host" value={`${data.server.cpu.toFixed(1)}%`} percent={data.server.cpu} icon="solar:cpu-linear" />
        <StatTile
          label="Memoria"
          value={fmtMem(data.server.memory.used)}
          hint={`di ${fmtMem(data.server.memory.total)}`}
          percent={memoryPercent}
          icon="solar:server-linear"
        />
        <StatTile label="Uptime" value={fmtUptime(data.server.uptime)} icon="solar:clock-circle-linear" />
      </div>

      {data.projects.length === 0 ? (
        <Panel>
          <EmptyState
            icon="solar:widget-2-linear"
            title="Nessun progetto"
            description="I progetti creati compariranno qui con i loro processi e servizi."
          />
        </Panel>
      ) : (
        <Panel padding="flush" className="divide-border divide-y overflow-hidden">
          <div className="text-muted flex items-center gap-3 px-3 py-2 text-[11px] font-medium">
            <span className="flex-1">Progetto</span>
            <span className="flex shrink-0 gap-3 sm:gap-5">
              <span className="w-14 text-right">CPU</span>
              <span className="w-16 text-right">RAM</span>
              <span className="hidden w-16 text-right sm:inline">Uptime</span>
            </span>
          </div>

          {data.projects.map((project) => {
            const isCollapsed = collapsed.has(project.id);
            const hasChildren = project.services.length > 0;

            return (
              <div key={project.id}>
                <Row
                  label={project.name}
                  sublabel={`${project.runtimeType}${project.port ? ` · :${project.port}` : ""}`}
                  status={project.status}
                  cpu={project.process?.cpu}
                  memory={project.process?.memory}
                  uptime={project.process?.uptime}
                  href={hasChildren ? undefined : `/projects/${project.id}`}
                  onToggle={hasChildren ? () => toggle(project.id) : undefined}
                  collapsed={isCollapsed}
                />

                {hasChildren && !isCollapsed && (
                  <div className="border-border/60 border-t">
                    {project.services.map((service) => (
                      <Row
                        key={service.id}
                        nested
                        label={service.name}
                        sublabel={`${service.type} · :${service.port}`}
                        status={service.status}
                        cpu={service.cpu}
                        memory={service.memory}
                        uptime={service.uptime}
                        href={`/services/${service.id}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </Panel>
      )}
    </>
  );
}
