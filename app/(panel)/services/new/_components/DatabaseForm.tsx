"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { cn } from "@/lib/utils";
import { DATABASE_OPTIONS, databaseOption, type ServiceType } from "../_data/catalog";

export function DatabaseForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  const [type, setType] = useState<ServiceType>("postgresql");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("16");
  const [port, setPort] = useState("5432");
  const [user, setUser] = useState("runpanel");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("runpanel_db");

  const option = databaseOption(type);

  function chooseType(next: ServiceType) {
    const opt = databaseOption(next);
    setType(next);
    setVersion(opt.versions[0]);
    setPort(String(opt.defaultPort));
    setUser(opt.credentialled ? "runpanel" : "");
    setDatabase(opt.credentialled ? "runpanel_db" : "0");
    setPassword("");
  }

  async function create() {
    if (!name.trim()) {
      toast.error("Serve un nome per il servizio");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          type,
          version,
          port: Number.parseInt(port, 10),
          projectId: projectId || undefined,
          credentials: {
            user: user.trim() || undefined,
            password: password || undefined,
            database: database.trim() || undefined,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Creazione fallita");
        return;
      }
      toast.success("Servizio creato");
      router.push(projectId ? `/projects/${projectId}` : "/services");
    } catch {
      toast.error("Creazione fallita");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Panel className="space-y-4">
        <PanelHeader title="Tipo" description="Il container viene provisionato con un volume dedicato" />

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {DATABASE_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              type="button"
              onClick={() => chooseType(opt.type)}
              aria-pressed={type === opt.type}
              className={cn(
                "flex flex-col items-center gap-2 rounded-[var(--radius)] border px-3 py-4 transition-colors",
                type === opt.type ? "border-accent bg-surface-secondary" : "border-border hover:bg-surface-hover"
              )}
            >
              <Icon icon={opt.icon} width={22} className="text-muted" aria-hidden />
              <span className="text-foreground text-xs">{opt.label}</span>
            </button>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField value={name} onChange={setName}>
            <Label>Nome del servizio</Label>
            <Input placeholder="db" />
          </TextField>

          <div>
            <span className="text-muted mb-2 block text-sm font-medium">Versione</span>
            <div className="flex flex-wrap gap-2">
              {option.versions.map((v) => (
                <Button key={v} size="sm" variant={version === v ? "primary" : "outline"} onPress={() => setVersion(v)}>
                  {v}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <TextField value={port} onChange={setPort}>
          <Label>Porta sull&apos;host</Label>
          <Input type="number" />
        </TextField>
      </Panel>

      <Panel className="space-y-4">
        <PanelHeader
          title="Credenziali"
          description="Lasciando vuoto, RunPanel genera una password casuale"
        />

        {option.credentialled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField value={user} onChange={setUser}>
              <Label>Utente</Label>
              <Input className="font-mono text-sm" />
            </TextField>
            <TextField value={database} onChange={setDatabase}>
              <Label>Database</Label>
              <Input className="font-mono text-sm" />
            </TextField>
          </div>
        )}

        <TextField value={password} onChange={setPassword}>
          <Label>Password</Label>
          <Input type="password" placeholder="generata automaticamente" className="font-mono text-sm" />
        </TextField>
      </Panel>

      <div className="flex justify-end">
        <Button variant="primary" isPending={saving} onPress={create}>
          Crea servizio
        </Button>
      </div>
    </div>
  );
}
