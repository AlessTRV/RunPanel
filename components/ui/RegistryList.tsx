"use client";

import { useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useResource } from "@/lib/hooks/useResource";
import { SkeletonBlock } from "./Skeletons";

interface Registry {
  registry: string;
  username: string;
}

/**
 * Credentials for private image registries.
 *
 * Written to a Docker config file the panel owns, pointed at with
 * `DOCKER_CONFIG` — rather than running `docker login`, which would write into
 * the host user's `~/.docker` and affect everything else they run.
 */
export function RegistryList() {
  const { data, loading, refresh } = useResource<{ registries: Registry[]; dockerHub: string }>(
    "/api/registries"
  );

  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [registry, setRegistry] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const registries = data?.registries ?? [];

  async function save() {
    if (!registry.trim() || !username.trim() || !password) {
      toast.error("Compila host, utente e password");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/registries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registry: registry.trim(), username: username.trim(), password }),
      });
      if (!res.ok) throw new Error();
      toast.success("Registry salvato");
      setRegistry("");
      setUsername("");
      setPassword("");
      setAdding(false);
      refresh();
    } catch {
      toast.error("Salvataggio fallito");
    } finally {
      setSaving(false);
    }
  }

  async function remove(host: string) {
    try {
      const res = await fetch(`/api/registries?registry=${encodeURIComponent(host)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
      toast.success("Registry rimosso");
      refresh();
    } catch {
      toast.error("Rimozione fallita");
    }
  }

  if (loading && !data) return <SkeletonBlock className="h-16" />;

  return (
    <div className="space-y-3">
      {registries.length === 0 ? (
        <p className="text-muted text-sm">
          Nessun registry configurato. Le immagini pubbliche funzionano comunque.
        </p>
      ) : (
        <ul className="divide-border divide-y">
          {registries.map((item) => (
            <li key={item.registry} className="flex items-center gap-3 py-2 first:pt-0">
              <Icon icon="solar:lock-linear" width={16} className="text-muted shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate font-mono text-xs">{item.registry}</p>
                <p className="text-muted truncate text-xs">{item.username}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={`Rimuovi ${item.registry}`}
                onPress={() => remove(item.registry)}
              >
                <Icon icon="solar:trash-bin-trash-linear" width={16} className="text-danger" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="border-border space-y-3 rounded-[var(--radius)] border p-3">
          <TextField value={registry} onChange={setRegistry}>
            <Label>Host</Label>
            <Input placeholder={data?.dockerHub ?? "ghcr.io"} className="font-mono text-sm" />
          </TextField>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField value={username} onChange={setUsername}>
              <Label>Utente</Label>
              <Input className="font-mono text-sm" />
            </TextField>
            <TextField value={password} onChange={setPassword}>
              <Label>Password o token</Label>
              <Input type="password" className="font-mono text-sm" />
            </TextField>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onPress={() => setAdding(false)}>
              Annulla
            </Button>
            <Button variant="primary" size="sm" isPending={saving} onPress={save}>
              Salva
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onPress={() => setAdding(true)}>
          <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
          Aggiungi registry
        </Button>
      )}
    </div>
  );
}
