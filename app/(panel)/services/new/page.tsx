"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
  TextField, Label, Input, Button, Spinner,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

type ServiceType = "postgresql" | "mysql" | "redis" | "mongodb";

const serviceOptions: { type: ServiceType; label: string; icon: string; defaultPort: number; versions: string[] }[] = [
  { type: "postgresql", label: "PostgreSQL", icon: "solar:database-bold-duotone", defaultPort: 5432, versions: ["16", "15", "14"] },
  { type: "mysql", label: "MySQL", icon: "solar:database-bold-duotone", defaultPort: 3306, versions: ["8", "5.7"] },
  { type: "redis", label: "Redis", icon: "solar:bolt-bold-duotone", defaultPort: 6379, versions: ["7", "6"] },
  { type: "mongodb", label: "MongoDB", icon: "solar:database-bold-duotone", defaultPort: 27017, versions: ["7", "6", "5"] },
];

export default function NewServicePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<ServiceType>("postgresql");
  const [version, setVersion] = useState("16");
  const [port, setPort] = useState("5432");

  const selectedOption = serviceOptions.find((o) => o.type === type)!;

  function handleTypeChange(newType: ServiceType) {
    setType(newType);
    const opt = serviceOptions.find((o) => o.type === newType)!;
    setVersion(opt.versions[0]);
    setPort(opt.defaultPort.toString());
  }

  async function handleCreate() {
    if (!name.trim()) {
      toast.error("Service name is required");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          type,
          version,
          port: parseInt(port),
        }),
      });

      if (res.ok) {
        toast.success("Service provisioned successfully");
        router.push("/services");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to provision service");
      }
    } catch {
      toast.error("Failed to provision service");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">New Service</h1>
        <p className="text-sm text-foreground-400">Provision a managed database or cache</p>
      </div>

      <div className="max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Service Type</CardTitle>
            <CardDescription>Choose the database or cache engine</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {serviceOptions.map((opt) => (
                <Button
                  key={opt.type}
                  variant={type === opt.type ? "primary" : "outline"}
                  className="flex flex-col h-auto py-3"
                  onPress={() => handleTypeChange(opt.type)}
                >
                  <Icon icon={opt.icon} width={24} />
                  <span className="text-xs mt-1">{opt.label}</span>
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <TextField value={name} onChange={setName} autoFocus>
              <Label>Service Name</Label>
              <Input placeholder="my-database" />
            </TextField>

            <div>
              <label className="block text-sm font-medium text-foreground-400 mb-2">Version</label>
              <div className="flex gap-2">
                {selectedOption.versions.map((v) => (
                  <Button
                    key={v}
                    variant={version === v ? "primary" : "outline"}
                    size="sm"
                    onPress={() => setVersion(v)}
                  >
                    {v}
                  </Button>
                ))}
              </div>
            </div>

            <TextField value={port} onChange={setPort}>
              <Label>Host Port</Label>
              <Input type="number" />
            </TextField>
          </CardContent>
        </Card>

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          isDisabled={loading}
          onPress={handleCreate}
        >
          {loading ? <Spinner /> : "Provision Service"}
        </Button>
      </div>
    </div>
  );
}
