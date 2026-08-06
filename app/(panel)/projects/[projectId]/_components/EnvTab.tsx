"use client";

import { useRef, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import type { EnvVar } from "./types";

/** Parse a .env file the same way a dotenv loader would, minus the exotica. */
function parseDotEnv(text: string): EnvVar[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const eq = line.indexOf("=");
      if (eq === -1) return null;
      return {
        key: line.slice(0, eq).trim(),
        value: line.slice(eq + 1).trim().replace(/^["']|["']$/g, ""),
      };
    })
    .filter((v): v is EnvVar => v !== null && v.key.length > 0);
}

/**
 * The editable copy is owned here and seeded from `initialVars` once. The
 * parent remounts this component (via `key`) when the fetch resolves, which is
 * how React means you to reset state from props — an effect that copies props
 * into state renders twice and fights with whatever the user has typed.
 */
export function EnvTab({
  projectId,
  runtimeType,
  initialVars,
  loading,
}: {
  projectId: string;
  runtimeType: string;
  initialVars: EnvVar[];
  loading: boolean;
}) {
  const [vars, onChange] = useState<EnvVar[]>(() =>
    initialVars.map((v) => ({ key: v.key, value: v.value }))
  );
  const [saving, setSaving] = useState(false);
  // A real file input instead of one created with document.createElement, so
  // the control is part of the tree and keyboard-reachable.
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function save() {
    const valid = vars.filter((v) => v.key.trim());
    if (valid.length === 0) {
      toast.error("Nessuna variabile da salvare");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vars: valid }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`${data.count ?? valid.length} variabili salvate`);
        onChange(valid);
      } else {
        toast.error(data.error ?? "Salvataggio fallito");
      }
    } catch {
      toast.error("Salvataggio fallito");
    } finally {
      setSaving(false);
    }
  }

  async function importFile(file: File) {
    const parsed = parseDotEnv(await file.text());
    const existing = new Set(vars.map((v) => v.key));
    const added = parsed.filter((v) => !existing.has(v.key));
    onChange([...vars, ...added]);
    toast.success(`${added.length} variabili importate${parsed.length !== added.length ? ` (${parsed.length - added.length} già presenti)` : ""}`);
  }

  return (
    <div className="space-y-4">
      {runtimeType === "docker" && (
        <Panel padding="compact" className="flex items-start gap-3">
          <Icon icon="solar:info-circle-linear" className="text-muted mt-0.5 shrink-0" width={18} />
          <p className="text-muted text-xs">
            Questo progetto gira in un container. Per raggiungere servizi sulla macchina host usa{" "}
            <code className="bg-surface-secondary text-foreground rounded px-1.5 py-0.5 font-mono">
              host.docker.internal
            </code>{" "}
            al posto di{" "}
            <code className="bg-surface-secondary rounded px-1.5 py-0.5 font-mono">localhost</code>.
          </p>
        </Panel>
      )}

      <div className="flex justify-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".env,.env.local,.env.production,text/plain"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importFile(file);
            e.target.value = "";
          }}
        />
        <Button variant="outline" size="sm" onPress={() => fileInputRef.current?.click()}>
          <Icon icon="solar:import-linear" width={16} aria-hidden />
          Importa .env
        </Button>
        <Button variant="outline" size="sm" onPress={() => onChange([...vars, { key: "", value: "" }])}>
          <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
          Aggiungi
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <SkeletonBlock key={i} className="h-14" />
          ))}
        </div>
      ) : vars.length === 0 ? (
        <Panel>
          <EmptyState
            icon="solar:key-linear"
            title="Nessuna variabile"
            description="Le variabili sono cifrate a riposo e iniettate nel processo al deploy."
          />
        </Panel>
      ) : (
        <Panel className="space-y-3">
          {vars.map((v, i) => (
            <div key={i} className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end">
              <div className="w-full sm:flex-1">
                <TextField
                  value={v.key}
                  onChange={(val) => onChange(vars.map((x, j) => (j === i ? { ...x, key: val } : x)))}
                >
                  <Label className="text-xs">Nome</Label>
                  <Input placeholder="NOME_VARIABILE" className="font-mono text-sm" />
                </TextField>
              </div>
              <div className="w-full sm:flex-[2]">
                <TextField
                  value={v.value}
                  onChange={(val) => onChange(vars.map((x, j) => (j === i ? { ...x, value: val } : x)))}
                >
                  <Label className="text-xs">Valore</Label>
                  <Input placeholder="valore" className="font-mono text-sm" />
                </TextField>
              </div>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                className="self-end"
                aria-label={`Rimuovi ${v.key || "variabile"}`}
                onPress={() => onChange(vars.filter((_, j) => j !== i))}
              >
                <Icon icon="solar:trash-bin-trash-linear" width={18} className="text-danger" />
              </Button>
            </div>
          ))}
        </Panel>
      )}

      {vars.length > 0 && (
        <div className="flex justify-end">
          <Button variant="primary" isPending={saving} onPress={save}>
            Salva variabili
          </Button>
        </div>
      )}
    </div>
  );
}
