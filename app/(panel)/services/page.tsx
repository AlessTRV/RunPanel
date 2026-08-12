"use client";

import { memo, useMemo, useState } from "react";
import Link from "next/link";
import { Button, Input } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useResource } from "@/lib/hooks/useResource";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Code, Hint } from "@/components/ui/Hint";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";

interface Service {
  id: string;
  name: string;
  type: string;
  version: string;
  status: string;
  port: number;
  project_id: string | null;
}

const TYPE_ICONS: Record<string, string> = {
  postgresql: "solar:database-linear",
  mysql: "solar:database-linear",
  mongodb: "solar:database-linear",
  redis: "solar:bolt-linear",
};

const ServiceRow = memo(function ServiceRow({
  service,
  projectName,
  onControl,
}: {
  service: Service;
  /** Undefined when the service belongs to no project — which is worth showing. */
  projectName?: string;
  onControl: (id: string, action: "start" | "stop" | "restart") => void;
}) {
  const running = service.status === "running";

  return (
    <Panel interactive padding="compact" className="flex items-center gap-3">
      <Icon
        icon={TYPE_ICONS[service.type] ?? "solar:database-linear"}
        width={20}
        className="text-muted shrink-0"
        aria-hidden
      />

      <Link href={`/services/${service.id}`} className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{service.name}</span>
          <StatusBadge status={service.status} />
        </div>
        <p className="text-muted mt-0.5 flex flex-wrap items-center gap-x-2 truncate text-xs">
          <span className="font-mono">
            {service.type} {service.version} · :{service.port}
          </span>
          {projectName ? (
            <span className="text-muted">
              → <span className="text-foreground">{projectName}</span>
            </span>
          ) : (
            <span className="text-warning">nessun progetto collegato</span>
          )}
        </p>
      </Link>

      <div className="flex shrink-0 gap-1.5">
        {running ? (
          <>
            <Button variant="ghost" size="sm" isIconOnly aria-label="Riavvia" onPress={() => onControl(service.id, "restart")}>
              <Icon icon="solar:refresh-linear" width={16} />
            </Button>
            <Button variant="ghost" size="sm" isIconOnly aria-label="Ferma" onPress={() => onControl(service.id, "stop")}>
              <Icon icon="solar:stop-linear" width={16} className="text-danger" />
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" isIconOnly aria-label="Avvia" onPress={() => onControl(service.id, "start")}>
            <Icon icon="solar:play-linear" width={16} className="text-success" />
          </Button>
        )}
      </div>
    </Panel>
  );
});

export default function ServicesPage() {
  const [search, setSearch] = useState("");
  const { data, loading, refresh } = useResource<Service[]>("/api/services", { intervalMs: 5000 });

  // Names only, and without polling: a service's project does not change while
  // the page is open, but "which project is this database attached to" is the
  // one thing this list was not answering.
  const { data: projectsData } = useResource<{ id: string; name: string }[]>("/api/projects");
  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of Array.isArray(projectsData) ? projectsData : []) {
      map.set(project.id, project.name);
    }
    return map;
  }, [projectsData]);

  const services = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return services;
    return services.filter(
      (s) => s.name.toLowerCase().includes(q) || s.type.toLowerCase().includes(q)
    );
  }, [services, search]);

  async function handleControl(serviceId: string, action: "start" | "stop" | "restart") {
    try {
      const res = await fetch(`/api/services/${serviceId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json();
        toast.error(body.error ?? `Azione "${action}" fallita`);
        return;
      }
      toast.success(`Azione "${action}" eseguita`);
      refresh();
    } catch {
      toast.error(`Azione "${action}" fallita`);
    }
  }

  if (loading && !data) return <PageSkeleton />;

  return (
    <>
      <PageHeader
        title="Servizi"
        description="Database e cache provisionati da RunPanel"
        actions={
          <Link
            href="/services/new"
            className="border-border bg-surface hover:bg-surface-hover text-foreground flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors"
          >
            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
            Nuovo servizio
          </Link>
        }
      />

      <Hint tone="tip" icon="solar:link-circle-linear" className="mb-4">
        Un servizio creato dentro un progetto gli si collega da solo: al deploy l&apos;app riceve{" "}
        <Code>DATABASE_URL</Code> (o <Code>REDIS_URL</Code>, <Code>MONGODB_URL</Code>) con host,
        porta e password già giusti. Uno senza progetto resta autonomo e lo usa chiunque: apri la
        sua pagina e copia la riga pronta — da un container si raggiunge su{" "}
        <Code>host.docker.internal</Code>, dalla macchina su <Code>localhost</Code>.
      </Hint>

      {services.length > 3 && (
        <div className="mb-4 max-w-sm">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cerca per nome o tipo…"
            aria-label="Cerca servizi"
          />
        </div>
      )}

      {filtered.length === 0 ? (
        <Panel>
          <EmptyState
            icon="solar:database-linear"
            title={services.length === 0 ? "Nessun servizio" : "Nessun risultato"}
            description={
              services.length === 0
                ? "PostgreSQL, MySQL, Redis o MongoDB, provisionati come container con volume dedicato. Aprine uno dal progetto che lo userà e il collegamento è già fatto."
                : "Nessun servizio corrisponde alla ricerca."
            }
          />
        </Panel>
      ) : (
        <div className="space-y-2">
          {filtered.map((service) => (
            <ServiceRow
              key={service.id}
              service={service}
              projectName={service.project_id ? projectNames.get(service.project_id) : undefined}
              onControl={handleControl}
            />
          ))}
        </div>
      )}
    </>
  );
}
