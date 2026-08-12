"use client";

import { memo } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { PageHeader } from "@/components/ui/PageHeader";
import { LinkButton } from "@/components/ui/LinkButton";
import { Panel } from "@/components/ui/Panel";
import { StatTile } from "@/components/ui/StatTile";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";
import { HealthBanner } from "@/components/HealthBanner";
import { statusMeta, TONE_DOT } from "@/lib/status";
import { formatBytes, formatUptime } from "@/lib/format";
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
  const poll5000 = usePollInterval(5000);

  const { data: projects, loading: projectsLoading, error } = useResource<Project[]>(
    "/api/projects",
    { intervalMs: poll5000 }
  );
  const { data: metrics } = useResource<Metrics>("/api/metrics", { intervalMs: poll5000 });

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
        title="Panoramica"
        description="Progetti e stato della macchina"
        actions={
          // A Link, not window.location: the latter is a full page reload —
          // re-downloading and re-hydrating the whole app — where client-side
          // navigation is instant.
          <LinkButton href="/projects/new" variant="secondary">
            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
            Nuovo progetto
          </LinkButton>
        }
      />

      {/* Above the metrics on purpose: a number that is merely interesting
          should never sit above a problem that needs doing. */}
      <HealthBanner />

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
          value={formatBytes(metrics?.memory.used)}
          hint={metrics ? `di ${formatBytes(metrics.memory.total)}` : undefined}
          percent={memoryPercent}
          icon="solar:server-linear"
        />
        <StatTile
          label="Disco"
          value={formatBytes(metrics?.disk.used)}
          hint={metrics ? `di ${formatBytes(metrics.disk.total)}` : undefined}
          percent={diskPercent}
          icon="solar:ssd-square-linear"
        />
        <StatTile
          label="Uptime"
          value={formatUptime(metrics?.uptime)}
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
