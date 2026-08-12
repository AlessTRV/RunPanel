"use client";

import { memo, useMemo, useState } from "react";
import Link from "next/link";
import { Input } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { PageHeader } from "@/components/ui/PageHeader";
import { LinkButton } from "@/components/ui/LinkButton";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";

interface Project {
  id: string;
  name: string;
  slug: string;
  runtime_type: string;
  status: string;
  port: number | null;
  source_branch: string;
  deploy_count: number;
  last_deploy_at: string | null;
}

/**
 * A dense list, as opposed to the Overview's cards.
 *
 * This route used to be a bare `redirect("/home")`, which meant the sidebar
 * could not offer "Projects" as a destination at all.
 */
const ProjectRow = memo(function ProjectRow({ project }: { project: Project }) {
  return (
    <Link href={`/projects/${project.id}`} className="block">
      <Panel interactive padding="compact" className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-foreground truncate text-sm font-medium">{project.name}</span>
            <StatusBadge status={project.status} />
          </div>
          <p className="text-muted mt-0.5 truncate font-mono text-xs">
            {project.runtime_type}
            {project.port ? ` · :${project.port}` : ""} · {project.source_branch}
          </p>
        </div>

        <div className="text-muted hidden shrink-0 text-right text-xs sm:block">
          <p className="tabular-nums">{project.deploy_count} deploy</p>
          {project.last_deploy_at && (
            <p className="mt-0.5">{new Date(project.last_deploy_at).toLocaleDateString()}</p>
          )}
        </div>

        <Icon icon="solar:alt-arrow-right-linear" width={16} className="text-muted shrink-0" aria-hidden />
      </Panel>
    </Link>
  );
});

export default function ProjectsPage() {
  const poll5000 = usePollInterval(5000);
  const [search, setSearch] = useState("");
  const { data, loading } = useResource<Project[]>("/api/projects", { intervalMs: poll5000 });

  const projects = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q)
    );
  }, [projects, search]);

  if (loading && !data) return <PageSkeleton />;

  return (
    <>
      <PageHeader
        title="Progetti"
        description="Tutti i progetti gestiti da questo pannello"
        actions={
          <LinkButton href="/projects/new" variant="secondary">
            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
            Nuovo progetto
          </LinkButton>
        }
      />

      {projects.length > 5 && (
        <div className="mb-4 max-w-sm">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cerca per nome…"
            aria-label="Cerca progetti"
          />
        </div>
      )}

      {filtered.length === 0 ? (
        <Panel>
          <EmptyState
            icon="solar:widget-2-linear"
            title={projects.length === 0 ? "Nessun progetto" : "Nessun risultato"}
            description={
              projects.length === 0
                ? "Un progetto contiene un'app e i servizi di cui ha bisogno."
                : "Nessun progetto corrisponde alla ricerca."
            }
          />
        </Panel>
      ) : (
        <div className="space-y-2">
          {filtered.map((project) => (
            <ProjectRow key={project.id} project={project} />
          ))}
        </div>
      )}
    </>
  );
}
