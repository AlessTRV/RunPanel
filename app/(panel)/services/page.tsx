"use client";

import { useEffect, useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, CardDescription, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { toast } from "sonner";

interface Service {
  id: string;
  name: string;
  type: string;
  version: string;
  status: string;
  port: number;
}

const typeIcons: Record<string, string> = {
  postgresql: "solar:database-bold-duotone",
  mysql: "solar:database-bold-duotone",
  redis: "solar:bolt-bold-duotone",
  mongodb: "solar:database-bold-duotone",
};

export default function ServicesPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/services")
      .then((r) => r.json())
      .then(setServices)
      .finally(() => setLoading(false));
  }, []);

  async function handleControl(serviceId: string, action: "start" | "stop" | "restart") {
    try {
      const res = await fetch(`/api/services/${serviceId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        toast.success(`Service ${action}ed`);
        // Refresh
        const updated = await fetch("/api/services").then((r) => r.json());
        setServices(updated);
      }
    } catch {
      toast.error(`Failed to ${action}`);
    }
  }

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner /></div>;
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Services</h1>
          <p className="text-sm text-foreground-400">Managed database and cache services</p>
        </div>
        <Link href="/services/new">
          <Button variant="primary">
            <Icon icon="solar:add-circle-bold-duotone" width={20} />
            New Service
          </Button>
        </Link>
      </div>

      {services.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-divider py-20">
          <Icon icon="solar:database-bold-duotone" className="mb-4 text-foreground-300" width={48} />
          <p className="text-foreground-400">No services yet</p>
          <p className="text-sm text-foreground-500">Provision a database or cache service</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {services.map((svc) => (
            <Card key={svc.id}>
              <CardHeader>
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      <Icon icon={typeIcons[svc.type] || typeIcons.postgresql} className="text-primary" width={22} />
                    </div>
                    <div>
                      <CardTitle className="text-base">{svc.name}</CardTitle>
                      <CardDescription>{svc.type} v{svc.version} · :{svc.port}</CardDescription>
                    </div>
                  </div>
                  <StatusBadge status={svc.status} />
                </div>
              </CardHeader>
              <CardContent className="flex gap-2 border-t border-divider pt-3">
                {svc.status === "running" ? (
                  <>
                    <Button variant="outline" size="sm" onPress={() => handleControl(svc.id, "restart")}>
                      <Icon icon="solar:refresh-bold-duotone" width={14} />
                      Restart
                    </Button>
                    <Button variant="danger" size="sm" onPress={() => handleControl(svc.id, "stop")}>
                      <Icon icon="solar:stop-bold-duotone" width={14} />
                      Stop
                    </Button>
                  </>
                ) : (
                  <Button variant="secondary" size="sm" onPress={() => handleControl(svc.id, "start")}>
                    <Icon icon="solar:play-bold-duotone" width={14} />
                    Start
                  </Button>
                )}
                <Link href={`/services/${svc.id}`}>
                  <Button variant="ghost" size="sm">
                    <Icon icon="solar:eye-bold-duotone" width={14} />
                    Details
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
