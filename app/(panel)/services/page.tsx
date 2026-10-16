"use client";

import { memo, useMemo, useState } from "react";
import Link from "next/link";
import { Button, Input } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadError } from "@/components/ui/LoadError";
import { LinkButton } from "@/components/ui/LinkButton";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Code } from "@/components/ui/Hint";
import { Section } from "@/components/ui/Section";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";
import { serviceDisplayName } from "@/lib/service-name";
import { useMemberApi, useServerHref } from "@/lib/hooks/useNode";
import { useClusterList } from "@/lib/hooks/useClusterList";
import type { Located } from "@/lib/cluster-merge";
import { ServerBadge, ServerFilter, UnreachableServers } from "@/components/cluster/ServerBits";

interface Service {
  id: string;
  name: string;
  type: string;
  version: string;
  status: string;
  port: number;
  project_id: string | null;
  access_mode: string | null;
}

const TYPE_ICONS: Record<string, string> = {
  postgresql: "solar:database-linear",
  mysql: "solar:database-linear",
  mongodb: "solar:database-linear",
  redis: "solar:bolt-linear",
};

const ServiceRow = memo(function ServiceRow({
  service,
  href,
  projectName,
  onControl,
}: {
  service: Located<Service>;
  href: string;
  /** Undefined when the service belongs to no project — which is worth showing. */
  projectName?: string;
  onControl: (service: Located<Service>, action: "start" | "stop" | "restart") => void;
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

      <Link href={href} className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{serviceDisplayName(service)}</span>
          <StatusBadge status={service.status} />
          <ServerBadge memberId={service.memberId} />
        </div>
        <p className="text-muted mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
          <span className="font-mono">
            {service.type} {service.version} · :{service.port}
          </span>
          {/*
            Only when limited. Open is the default and marking it would turn a
            neutral state into a warning on every row.
          */}
          {service.access_mode === "restricted" && (
            <span className="text-muted inline-flex items-center gap-1" title="Accesso limitato a reti specifiche">
              <Icon icon="solar:lock-keyhole-minimalistic-linear" width={13} aria-hidden />
              limitato
            </span>
          )}
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
            <Button variant="ghost" size="sm" isIconOnly aria-label="Riavvia" onPress={() => onControl(service, "restart")}>
              <Icon icon="solar:refresh-linear" width={16} />
            </Button>
            <Button variant="ghost" size="sm" isIconOnly aria-label="Ferma" onPress={() => onControl(service, "stop")}>
              <Icon icon="solar:stop-linear" width={16} className="text-danger" />
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" isIconOnly aria-label="Avvia" onPress={() => onControl(service, "start")}>
            <Icon icon="solar:play-linear" width={16} className="text-success" />
          </Button>
        )}
      </div>
    </Panel>
  );
});

export default function ServicesPage() {
  const memberApi = useMemberApi();
  const href = useServerHref();
  const poll5000 = usePollInterval(5000);
  const [search, setSearch] = useState("");
  const { items: data, failed, loading, error: loadError, refresh } = useClusterList<Service>("/api/cluster/services", "/api/services", { intervalMs: poll5000 });

  // Names only, and without polling: a service's project does not change while
  // the page is open, but "which project is this database attached to" is the
  // one thing this list was not answering.
  const { items: projectsData } = useClusterList<{ id: string; name: string }>("/api/cluster/projects", "/api/projects");
  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of Array.isArray(projectsData) ? projectsData : []) {
      map.set(`${project.memberId}:${project.id}`, project.name);
    }
    return map;
  }, [projectsData]);

  const services = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return services;
    return services.filter(
      (s) =>
        serviceDisplayName(s).toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.type.toLowerCase().includes(q)
    );
  }, [services, search]);

  async function handleControl(service: Located<Service>, action: "start" | "stop" | "restart") {
    try {
      const res = await fetch(memberApi(service.memberId, `/api/services/${service.id}/control`), {
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
          <>
            <ServerFilter />
            <LinkButton href={href("/services/new")} variant="secondary">
              <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
              Nuovo servizio
            </LinkButton>
          </>
        }
      />

      {/* Read once, then known: closed, so it stops pushing the list down on
          every visit. */}
      <Section
        title="Come si collegano i servizi"
        summary="Dentro un progetto: variabili automatiche. Autonomi: riga di connessione da copiare."
        className="mb-4"
      >
        <p className="text-muted text-sm">
          Un servizio creato dentro un progetto gli si collega da solo: al deploy l&apos;app riceve{" "}
          <Code>DATABASE_URL</Code> (o <Code>REDIS_URL</Code>, <Code>MONGODB_URL</Code>) con host,
          porta e password già giusti. Uno senza progetto resta autonomo e lo usa chiunque: apri la
          sua pagina e copia la riga pronta — da un container si raggiunge su{" "}
          <Code>host.docker.internal</Code>, dalla macchina su <Code>localhost</Code>.
        </p>
      </Section>

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

      <UnreachableServers failed={failed} what="i servizi" className="mb-4" />

      {!data && loadError ? (
        <LoadError what="i servizi" error={loadError} onRetry={() => void refresh()} />
      ) : filtered.length === 0 ? (
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
              key={`${service.memberId}:${service.id}`}
              service={service}
              href={href(`/services/${service.id}`, service.memberId)}
              projectName={service.project_id ? projectNames.get(`${service.memberId}:${service.project_id}`) : undefined}
              onControl={handleControl}
            />
          ))}
        </div>
      )}
    </>
  );
}
