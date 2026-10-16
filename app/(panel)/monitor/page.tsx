"use client";

import { memo, useCallback, useState } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadError } from "@/components/ui/LoadError";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { statusMeta, TONE_DOT } from "@/lib/status";
import { formatBytes, formatUptime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { serviceDisplayName } from "@/lib/service-name";
import { useNode, useServerHref } from "@/lib/hooks/useNode";
import { ServerFilter } from "@/components/cluster/ServerBits";
import { Hint } from "@/components/ui/Hint";
import type { PerServer } from "@/lib/cluster-merge";

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
  /** Services belonging to no project, which have no project row to nest under. */
  services: ServiceInfo[];
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
          {formatBytes(memory)}
        </span>
        <span className="hidden w-16 text-right sm:inline" title="Uptime">
          {formatUptime(uptime)}
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

/** One server's processes: the host in one line, then projects and standalone services. */
function HostMonitor({
  data,
  link,
  collapsed,
  toggle,
  keyPrefix,
}: {
  data: MonitorData;
  link: (href: string) => string;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  keyPrefix: string;
}) {
  const standalone = data.services ?? [];
  return (
    <>
      {/* The host in one line. The same three numbers are tiles on the
          Panoramica; here the page is about the processes, so the machine is
          context rather than the headline. */}
      <p className="text-muted mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
        <span className="flex items-center gap-1.5">
          <Icon icon="solar:cpu-linear" width={14} aria-hidden />
          CPU host <span className="text-foreground">{data.server.cpu.toFixed(1)}%</span>
        </span>
        <span className="flex items-center gap-1.5">
          <Icon icon="solar:server-linear" width={14} aria-hidden />
          Memoria{" "}
          <span className="text-foreground">
            {formatBytes(data.server.memory.used)} di {formatBytes(data.server.memory.total)}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <Icon icon="solar:clock-circle-linear" width={14} aria-hidden />
          Uptime <span className="text-foreground">{formatUptime(data.server.uptime)}</span>
        </span>
      </p>

      {data.projects.length === 0 && standalone.length === 0 ? (
        <Panel>
          <EmptyState
            icon="solar:widget-2-linear"
            title="Nessun progetto"
            description="I progetti creati compariranno qui con i loro processi e servizi."
          />
        </Panel>
      ) : data.projects.length > 0 ? (
        <Panel padding="flush" className="divide-border divide-y overflow-hidden">
          <div className="text-muted flex items-center gap-3 px-3 py-2 text-meta font-medium">
            <span className="flex-1">Progetto</span>
            <span className="flex shrink-0 gap-3 sm:gap-5">
              <span className="w-14 text-right">CPU</span>
              <span className="w-16 text-right">RAM</span>
              <span className="hidden w-16 text-right sm:inline">Uptime</span>
            </span>
          </div>

          {data.projects.map((project) => {
            const key = `${keyPrefix}${project.id}`;
            const isCollapsed = collapsed.has(key);
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
                  href={hasChildren ? undefined : link(`/projects/${project.id}`)}
                  onToggle={hasChildren ? () => toggle(key) : undefined}
                  collapsed={isCollapsed}
                />

                {hasChildren && !isCollapsed && (
                  <div className="border-border/60 border-t">
                    {project.services.map((service) => (
                      <Row
                        key={service.id}
                        nested
                        label={serviceDisplayName(service)}
                        sublabel={`${service.type} · :${service.port}`}
                        status={service.status}
                        cpu={service.cpu}
                        memory={service.memory}
                        uptime={service.uptime}
                        href={link(`/services/${service.id}`)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </Panel>
      ) : null}

      {/* Services with no project have no row to nest under, and used to be
          filtered out of this page entirely — a running container with no
          CPU or memory reading anywhere in the panel. */}
      {standalone.length > 0 && (
        <>
          <h2 className="text-muted mt-6 mb-2 text-meta font-medium">Servizi autonomi</h2>
          <Panel padding="flush" className="divide-border divide-y overflow-hidden">
            {standalone.map((service) => (
              <Row
                key={service.id}
                label={serviceDisplayName(service)}
                sublabel={`${service.type} · :${service.port}`}
                status={service.status}
                cpu={service.cpu}
                memory={service.memory}
                uptime={service.uptime}
                href={link(`/services/${service.id}`)}
              />
            ))}
          </Panel>
        </>
      )}
    </>
  );
}

export default function MonitorPage() {
  const href = useServerHref();
  const { isSolo, serverParam, selfId } = useNode();
  const poll3000 = usePollInterval(3000);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Polls, but stops while the tab is hidden — this endpoint inspects
  // containers, so an idle background tab was doing real work on the host
  // every three seconds forever. In a cluster the panel asks every server.
  const solo = useResource<MonitorData>(isSolo ? "/api/monitor" : null, { intervalMs: poll3000 });
  const cluster = useResource<{ servers: PerServer<MonitorData>[] }>(isSolo ? null : "/api/cluster/monitor", {
    intervalMs: Math.max(poll3000, 5000),
  });

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const description = isSolo ? "Processi e servizi in esecuzione su questo host" : "Processi e servizi in esecuzione su ogni server";
  const loading = isSolo ? solo.loading && !solo.data : cluster.loading && !cluster.data;
  if (loading) return <PageSkeleton title="Monitor" description={description} tiles={0} />;

  if (isSolo) {
    if (!solo.data) {
      return (
        <>
          <PageHeader title="Monitor" description={description} />
          <LoadError what="il monitor" error={solo.error ?? "Nessuna risposta"} onRetry={() => void solo.refresh()} />
        </>
      );
    }
    return (
      <>
        <PageHeader title="Monitor" description={description} />
        <HostMonitor data={solo.data} link={(h) => h} collapsed={collapsed} toggle={toggle} keyPrefix="" />
      </>
    );
  }

  const servers = (cluster.data?.servers ?? []).filter((s) => !serverParam || s.memberId === serverParam);
  return (
    <>
      <PageHeader title="Monitor" description={description} actions={<ServerFilter />} />
      {!cluster.data && cluster.error ? (
        <LoadError what="il monitor" error={cluster.error} onRetry={() => void cluster.refresh()} />
      ) : (
        <div className="space-y-8">
          {servers.map((server) => (
            <section key={server.memberId} aria-label={`Server ${server.memberName}`}>
              <h2 className="text-foreground mb-2 flex items-center gap-2 text-sm font-semibold">
                <Icon icon="solar:server-2-linear" width={16} className="text-muted" aria-hidden />
                {server.memberName}
                {server.memberId === selfId && <span className="text-muted font-normal">(questo)</span>}
              </h2>
              {server.data ? (
                <HostMonitor
                  data={server.data}
                  link={(h) => href(h, server.memberId)}
                  collapsed={collapsed}
                  toggle={toggle}
                  keyPrefix={`${server.memberId}:`}
                />
              ) : (
                <Hint tone={server.reachable ? "info" : "warn"}>
                  {server.reachable
                    ? `Il monitor di ${server.memberName} non è disponibile per il tuo account (${server.error ?? "accesso negato"}).`
                    : `${server.memberName} non raggiungibile. ${server.error ?? ""}`}
                </Hint>
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
