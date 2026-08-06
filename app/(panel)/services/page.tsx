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
import { PageSkeleton } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";

interface Service {
  id: string;
  name: string;
  type: string;
  version: string;
  status: string;
  port: number;
}

const TYPE_ICONS: Record<string, string> = {
  postgresql: "solar:database-linear",
  mysql: "solar:database-linear",
  mongodb: "solar:database-linear",
  redis: "solar:bolt-linear",
};

const ServiceRow = memo(function ServiceRow({
  service,
  onControl,
}: {
  service: Service;
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
        <p className="text-muted mt-0.5 truncate font-mono text-xs">
          {service.type} {service.version} · :{service.port}
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
                ? "Provisiona PostgreSQL, MySQL, Redis o MongoDB e collegalo a un progetto."
                : "Nessun servizio corrisponde alla ricerca."
            }
          />
        </Panel>
      ) : (
        <div className="space-y-2">
          {filtered.map((service) => (
            <ServiceRow key={service.id} service={service} onControl={handleControl} />
          ))}
        </div>
      )}
    </>
  );
}
