"use client";

import { useMemo, useRef, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { MSG } from "@/lib/copy";
import { useResource } from "@/lib/hooks/useResource";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { Code, Hint } from "@/components/ui/Hint";
import { BuildEnvHint, ManagedEnvHint, ServiceLinkHint } from "@/components/DeployHints";
import { InfoTip } from "@/components/ui/Tooltip";
import { ServiceLink } from "@/components/ServiceLink";
import type { EnvVar } from "./types";

interface LinkedService {
  id: string;
  name: string;
  type: string;
  status: string;
  port: number;
  project_id: string | null;
  inject_env: number | null;
  env_key: string | null;
}

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
  buildEnvPrefixes,
  initialVars,
  loading,
}: {
  projectId: string;
  runtimeType: string;
  buildEnvPrefixes: string[];
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

  // Which services this project will be handed at the next deploy. Listed here
  // because this is where someone looks for DATABASE_URL, does not find it, and
  // pastes a connection string by hand — over the one RunPanel was about to
  // inject, which then silently wins forever.
  const { data: servicesData, refresh: refreshServices } = useResource<LinkedService[]>("/api/services");
  const linkedServices = useMemo(
    () => (Array.isArray(servicesData) ? servicesData : []).filter((s) => s.project_id === projectId),
    [servicesData, projectId]
  );

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
        toast.error(data.error ?? MSG.saveFailed);
      }
    } catch {
      toast.error(MSG.saveFailed);
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
      {linkedServices.length > 0 ? (
        <Panel className="space-y-3">
          <PanelHeader
            title="Servizi collegati"
            description="Ognuno fornisce una variabile, se acceso"
            actions={
              <InfoTip title="Come viene scelto l'host">
                Un&apos;app in container raggiunge il servizio per nome del container sulla rete del
                progetto; un processo nativo lo raggiunge su <Code>localhost</Code> alla porta
                pubblicata. RunPanel costruisce la URL di conseguenza.
              </InfoTip>
            }
          />

          <ul className="space-y-2">
            {linkedServices.map((service) => (
              <li key={service.id}>
                <ServiceLink
                  service={service}
                  projectKeys={vars.map((v) => v.key)}
                  onChanged={refreshServices}
                />
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <ServiceLinkHint projectId={projectId} />
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
            description="Cifrate a riposo, iniettate al deploy. Il modo più rapido è importare il tuo .env."
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
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className="text-muted mr-auto text-meta">
            Salvare non riavvia niente: le variabili entrano in vigore al prossimo deploy. Quelle
            che il build compila nel bundle vanno salvate <em>prima</em> di lanciarlo.
          </p>
          <Button variant="primary" isPending={saving} onPress={save}>
            Salva variabili
          </Button>
        </div>
      )}

      {/* Reference rather than instructions: kept under the editor so the thing
          you came here to do is the first thing on screen. */}
      <div className="border-border space-y-3 border-t pt-4">
        <BuildEnvHint prefixes={buildEnvPrefixes} />
        <ManagedEnvHint runtimeType={runtimeType} />
        {runtimeType === "docker" && (
          <Hint>
            Questo progetto gira in un container: per raggiungere qualcosa che sta sulla macchina
            host — un database installato lì, un altro servizio già attivo — usa{" "}
            <Code>host.docker.internal</Code> al posto di <Code>localhost</Code>, che dentro il
            container è il container stesso.
          </Hint>
        )}
      </div>
    </div>
  );
}
