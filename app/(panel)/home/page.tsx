"use client";

import { memo } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { useResource } from "@/lib/hooks/useResource";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";
import { statusMeta, TONE_DOT } from "@/lib/status";
import { cn } from "@/lib/utils";

interface Service {
  id: string;
  name: string;
  type: string;
  version: string;
  status: string;
  port: number;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  app_name: string | null;
  source_type: string;
  source_url: string | null;
  runtime_type: string;
  status: string;
  port: number | null;
  deploy_count: number;
  services: Service[];
}

interface Metrics {
  cpu: { usage: number; cores: number };
  memory: { total: number; used: number };
  disk: { total: number; used: number; free: number };
  uptime: number;
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}g ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Memoised so a 5-second metrics refresh does not re-render every card. */
const ProjectCard = memo(function ProjectCard({ project }: { project: Project }) {
  return (
    <Panel interactive padding="compact" className="flex flex-col gap-3">
      <Link href={`/projects/${project.id}`} className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-foreground truncate text-sm font-medium">{project.name}</h3>
            <StatusBadge status={project.status} />
          </div>
          <p className="text-muted mt-1 truncate font-mono text-xs">
            {project.runtime_type}
            {project.port ? ` · :${project.port}` : ""}
            {project.deploy_count > 0 ? ` · ${project.deploy_count} deploy` : ""}
          </p>
        </div>
        <Icon icon="solar:alt-arrow-right-linear" width={16} className="text-muted mt-0.5 shrink-0" aria-hidden />
      </Link>

      {project.services.length > 0 && (
        <ul className="border-border flex flex-wrap gap-1.5 border-t pt-3">
          {project.services.map((service) => {
            const meta = statusMeta(service.status);
            return (
              <li key={service.id}>
                <Link
                  href={`/services/${service.id}`}
                  className="border-border bg-surface-secondary hover:bg-surface-hover flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors"
                >
                  <span className={cn("size-1.5 rounded-full", TONE_DOT[meta.tone])} aria-hidden />
                  <span className="text-foreground">{service.name}</span>
                  <span className="text-muted font-mono">{service.type}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
});

export default function HomePage() {
  // Both endpoints go through the shared hook, so they stop polling when the
  // tab is hidden and never overlap requests.
  const { data: projects, loading: projectsLoading, error } = useResource<Project[]>(
    "/api/projects",
    { intervalMs: 5000 }
  );
  const { data: metrics } = useResource<Metrics>("/api/metrics", { intervalMs: 5000 });

  if (projectsLoading && !projects) return <PageSkeleton />;

  const list = Array.isArray(projects) ? projects : [];
  const memoryPercent = metrics?.memory.total
    ? (metrics.memory.used / metrics.memory.total) * 100
    : undefined;
  const diskPercent = metrics?.disk.total
    ? (metrics.disk.used / metrics.disk.total) * 100
    : undefined;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Progetti e stato della macchina"
        actions={
          // A Link, not window.location: the latter is a full page reload —
          // re-downloading and re-hydrating the whole app — where client-side
          // navigation is instant.
          <Link
            href="/projects/new"
            className="border-border bg-surface hover:bg-surface-hover text-foreground flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors"
          >
            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
            Nuovo progetto
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="CPU"
          value={metrics ? `${metrics.cpu.usage.toFixed(1)}%` : "—"}
          hint={metrics ? `${metrics.cpu.cores} core` : undefined}
          percent={metrics?.cpu.usage}
          icon="solar:cpu-linear"
        />
        <StatTile
          label="Memoria"
          value={metrics ? formatBytes(metrics.memory.used) : "—"}
          hint={metrics ? `di ${formatBytes(metrics.memory.total)}` : undefined}
          percent={memoryPercent}
          icon="solar:server-linear"
        />
        <StatTile
          label="Disco"
          value={metrics ? formatBytes(metrics.disk.used) : "—"}
          hint={metrics ? `di ${formatBytes(metrics.disk.total)}` : undefined}
          percent={diskPercent}
          icon="solar:ssd-square-linear"
        />
        <StatTile
          label="Uptime"
          value={metrics ? formatUptime(metrics.uptime) : "—"}
          icon="solar:clock-circle-linear"
        />
      </div>

      {error && (
        <Panel className="border-danger/30 mb-4">
          <p className="text-danger text-sm">
            Impossibile leggere i progetti: {error}. Il polling continua.
          </p>
        </Panel>
      )}

      {list.length === 0 ? (
        <Panel>
          <EmptyState
            icon="solar:widget-2-linear"
            title="Nessun progetto"
            description="Un progetto contiene un'app e i servizi di cui ha bisogno."
            action={
              <Link
                href="/projects/new"
                className="border-border bg-surface hover:bg-surface-hover text-foreground rounded-[var(--radius)] border px-4 py-2 text-sm transition-colors"
              >
                Crea il primo progetto
              </Link>
            }
          />
        </Panel>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </>
  );
}
