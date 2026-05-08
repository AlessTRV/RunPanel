"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
  Button, Spinner,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/StatusBadge";

interface Service {
  id: string;
  name: string;
  type: string;
  version: string;
  status: string;
  port: number;
  credentials: string;
  created_at: string;
}

export default function ServiceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const serviceId = params.serviceId as string;
  const [service, setService] = useState<Service | null>(null);
  const [loading, setLoading] = useState(true);
  const [creds, setCreds] = useState<Record<string, string> | null>(null);
  const [showCreds, setShowCreds] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function loadService() {
      try {
        const res = await fetch(`/api/services/${serviceId}`, { signal: controller.signal });
        if (res.ok) setService(await res.json());
      } catch (e) { if (e instanceof Error && e.name === "AbortError") return; }
      finally { setLoading(false); }
    }
    loadService();
    const interval = setInterval(loadService, 5000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [serviceId]);

  async function revealCredentials() {
    const res = await fetch(`/api/services/${serviceId}?reveal=true`);
    if (res.ok) {
      const data = await res.json();
      setCreds(JSON.parse(data.credentials));
      setShowCreds(true);
    }
  }

  async function handleControl(action: "start" | "stop" | "restart") {
    try {
      const res = await fetch(`/api/services/${serviceId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        toast.success(`Service ${action}ed`);
        const updated = await fetch(`/api/services/${serviceId}`);
        if (updated.ok) setService(await updated.json());
      } else { toast.error(`Failed to ${action}`); }
    } catch { toast.error(`Failed to ${action}`); }
  }

  async function handleDelete() {
    if (!confirm("Delete this service? All data will be lost.")) return;
    const res = await fetch(`/api/services/${serviceId}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Service deleted");
      router.push("/services");
    } else {
      toast.error("Failed to delete service");
    }
  }

  if (loading || !service) {
    return <div className="flex justify-center py-20"><Spinner /></div>;
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Icon icon="solar:database-bold-duotone" className="text-primary" width={28} />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">{service.name}</h1>
              <StatusBadge status={service.status} />
            </div>
            <p className="text-sm text-foreground-400">
              {service.type} v{service.version} · Port {service.port}
            </p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          {service.status === "running" ? (
            <>
              <Button variant="outline" size="sm" onPress={() => handleControl("restart")}>
                <Icon icon="solar:refresh-bold-duotone" width={14} />Restart
              </Button>
              <Button variant="danger" size="sm" onPress={() => handleControl("stop")}>
                <Icon icon="solar:stop-bold-duotone" width={14} />Stop
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onPress={() => handleControl("start")}>
              <Icon icon="solar:play-bold-duotone" width={14} />Start
            </Button>
          )}
        </div>
      </div>

      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Connection Details</CardTitle>
            <CardDescription>Use these credentials to connect to your service</CardDescription>
          </CardHeader>
          <CardContent>
            {showCreds && creds ? (
              <div className="space-y-2 font-mono text-sm">
                {Object.entries(creds).map(([key, value]) => (
                  <div key={key} className="flex justify-between rounded-lg border border-white/[0.07] bg-black/40 backdrop-blur-xl px-3 py-2">
                    <span className="text-foreground-400">{key}:</span>
                    <span className="text-foreground">{value}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Button variant="secondary" onPress={revealCredentials}>
                <Icon icon="solar:eye-bold-duotone" width={18} />
                Reveal Credentials
              </Button>
            )}
          </CardContent>
        </Card>

        <Card className="border-danger/30">
          <CardHeader>
            <CardTitle className="text-danger">Danger Zone</CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="danger" onPress={handleDelete}>
              <Icon icon="solar:trash-bin-trash-bold-duotone" width={18} />
              Delete Service
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
