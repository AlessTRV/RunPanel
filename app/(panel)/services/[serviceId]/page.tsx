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
    fetch(`/api/services/${serviceId}`)
      .then((r) => r.ok ? r.json() : null)
      .then(setService)
      .finally(() => setLoading(false));
  }, [serviceId]);

  async function revealCredentials() {
    const res = await fetch(`/api/services/${serviceId}?reveal=true`);
    if (res.ok) {
      const data = await res.json();
      setCreds(JSON.parse(data.credentials));
      setShowCreds(true);
    }
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
      <div className="mb-6 flex items-center justify-between">
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
