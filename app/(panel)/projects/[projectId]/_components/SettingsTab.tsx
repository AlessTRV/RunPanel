"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { CopyField } from "@/components/ui/CopyField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { parseContractJson, type DeployContract } from "@/lib/deploy-contract";
import type { Project } from "./types";

/** A labelled multi-line field. Six of these were inline copies before. */
function CommandField({
  label,
  hint,
  value,
  placeholder,
  rows = 2,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  rows?: number;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="text-muted mb-1 block text-sm font-medium">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="border-border bg-background text-foreground focus:border-accent/60 w-full resize-y rounded-[var(--radius)] border px-3 py-2 font-mono text-sm outline-none"
      />
      {hint && <p className="text-muted mt-1 text-[11px]">{hint}</p>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-default"
      }`}
    >
      <span
        className={`bg-background inline-block size-4 rounded-full transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export function SettingsTab({
  project,
  onProjectChange,
}: {
  project: Project;
  onProjectChange: (project: Project) => void;
}) {
  const router = useRouter();
  const [contract, setContract] = useState<DeployContract>(() =>
    parseContractJson(project.builder_config)
  );
  const [appName, setAppName] = useState(project.app_name ?? "");
  const [branch, setBranch] = useState(project.source_branch);
  const [port, setPort] = useState(project.port?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmRemoveApp, setConfirmRemoveApp] = useState(false);

  const isDocker = project.runtime_type === "docker";

  function patchContract(patch: Partial<DeployContract>) {
    setContract((prev) => ({ ...prev, ...patch }));
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appName: appName.trim() || null,
          sourceBranch: branch,
          port: port ? Number.parseInt(port, 10) : null,
          builderConfig: contract,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success("Impostazioni salvate");
        onProjectChange(data);
      } else {
        toast.error(data.error ?? "Salvataggio fallito");
      }
    } catch {
      toast.error("Salvataggio fallito");
    } finally {
      setSaving(false);
    }
  }

  async function toggleAutoDeploy(enabled: boolean) {
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoDeploy: enabled }),
      });
      if (!res.ok) throw new Error();
      onProjectChange({ ...project, auto_deploy: enabled ? 1 : 0 });
      toast.success(enabled ? "Auto-deploy attivo" : "Auto-deploy disattivato");
    } catch {
      toast.error("Aggiornamento fallito");
    }
  }

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/webhooks/github/${project.id}`
      : "";

  return (
    <div className="max-w-3xl space-y-4">
      <Panel className="space-y-4">
        <PanelHeader title="Applicazione" description="Sorgente, porta e comandi" />

        <TextField value={appName} onChange={setAppName}>
          <Label>Nome app</Label>
          <Input placeholder={project.slug} />
        </TextField>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField value={branch} onChange={setBranch}>
            <Label>Branch</Label>
            <Input />
          </TextField>
          <TextField value={port} onChange={setPort}>
            <Label>Porta</Label>
            <Input type="number" placeholder="3000" />
          </TextField>
        </div>

        {project.runtime_type === "node" && (
          <div>
            <span className="text-muted mb-2 block text-sm font-medium">Package manager</span>
            <div className="flex flex-wrap gap-2">
              {(["auto", "npm", "bun", "pnpm", "yarn"] as const).map((pm) => (
                <Button
                  key={pm}
                  size="sm"
                  variant={contract.packageManager === pm ? "primary" : "outline"}
                  onPress={() => patchContract({ packageManager: pm })}
                >
                  {pm === "auto" ? "Auto" : pm}
                </Button>
              ))}
            </div>
          </div>
        )}

        {!isDocker && (
          <div className="border-border space-y-3 border-t pt-4">
            <CommandField
              label="Comandi di install"
              value={contract.commands.install ?? ""}
              placeholder={project.runtime_type === "node" ? "rilevato automaticamente" : "pip install -r requirements.txt"}
              hint="Un comando per riga, eseguiti in ordine nella stessa shell."
              onChange={(v) => patchContract({ commands: { ...contract.commands, install: v } })}
            />
            <CommandField
              label="Comandi di build"
              value={contract.commands.build ?? ""}
              placeholder={project.runtime_type === "node" ? "rilevato automaticamente" : "go build -o app ."}
              onChange={(v) => patchContract({ commands: { ...contract.commands, build: v } })}
            />
            <CommandField
              label="Comando di start"
              rows={1}
              value={contract.commands.start ?? ""}
              placeholder={project.runtime_type === "node" ? "rilevato automaticamente" : "./app"}
              hint="Solo la prima riga viene usata come comando di avvio."
              onChange={(v) => patchContract({ commands: { ...contract.commands, start: v } })}
            />
          </div>
        )}

        <div className="border-border border-t pt-4">
          <CommandField
            label="Release command"
            rows={2}
            value={contract.commands.release ?? ""}
            placeholder="npx prisma migrate deploy"
            hint="Eseguito una volta dopo il build e prima dell'avvio. Se fallisce, il deploy fallisce."
            onChange={(v) => patchContract({ commands: { ...contract.commands, release: v } })}
          />
        </div>
      </Panel>

      <Panel className="space-y-4">
        <PanelHeader
          title="Health check"
          description="Come RunPanel capisce che l'app è davvero partita"
        />

        <div className="flex items-center justify-between gap-4">
          <p className="text-muted text-sm">Attendi che risponda prima di dichiarare il deploy riuscito</p>
          <Toggle
            checked={contract.healthcheck.enabled}
            label="Attiva health check"
            onChange={(v) => patchContract({ healthcheck: { ...contract.healthcheck, enabled: v } })}
          />
        </div>

        {contract.healthcheck.enabled && (
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              value={contract.healthcheck.path}
              onChange={(v) => patchContract({ healthcheck: { ...contract.healthcheck, path: v } })}
            >
              <Label>Path</Label>
              <Input placeholder="/" className="font-mono text-sm" />
            </TextField>
            <TextField
              value={String(contract.healthcheck.startPeriodSec)}
              onChange={(v) =>
                patchContract({
                  healthcheck: { ...contract.healthcheck, startPeriodSec: Number.parseInt(v, 10) || 0 },
                })
              }
            >
              <Label>Attesa iniziale (s)</Label>
              <Input type="number" />
            </TextField>
            <TextField
              value={String(contract.healthcheck.timeoutSec)}
              onChange={(v) =>
                patchContract({
                  healthcheck: { ...contract.healthcheck, timeoutSec: Number.parseInt(v, 10) || 30 },
                })
              }
            >
              <Label>Timeout (s)</Label>
              <Input type="number" />
            </TextField>
          </div>
        )}
      </Panel>

      <Panel className="space-y-4">
        <PanelHeader
          title="Ambiente"
          description="Come le variabili raggiungono build e runtime"
        />

        <p className="text-muted text-xs">
          Le variabili con prefisso{" "}
          <code className="bg-surface-secondary rounded px-1 py-0.5 font-mono">
            {contract.buildEnvPrefixes.join(", ")}
          </code>{" "}
          vengono passate anche al <strong>build</strong>: molti framework le compilano dentro il
          bundle, quindi fornirle solo a runtime spedisce il valore sbagliato.
        </p>

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-foreground text-sm">Scrivi un file .env</p>
            <p className="text-muted text-xs">
              Per le app che leggono un dotenv invece di process.env.
            </p>
          </div>
          <Toggle
            checked={contract.envFile.enabled}
            label="Genera il file .env"
            onChange={(v) => patchContract({ envFile: { ...contract.envFile, enabled: v } })}
          />
        </div>

        {contract.envFile.enabled && (
          <TextField
            value={contract.envFile.path}
            onChange={(v) => patchContract({ envFile: { ...contract.envFile, path: v } })}
          >
            <Label>Percorso del file</Label>
            <Input placeholder="/app/.env" className="font-mono text-sm" />
          </TextField>
        )}
      </Panel>

      {isDocker && (
        <Panel className="space-y-4">
          <PanelHeader title="Container" description="Rete, limiti e policy di riavvio" />

          <div>
            <span className="text-muted mb-2 block text-sm font-medium">Rete</span>
            <div className="flex flex-wrap gap-2">
              {(["project", "bridge", "host"] as const).map((mode) => (
                <Button
                  key={mode}
                  size="sm"
                  variant={contract.docker.network === mode ? "primary" : "outline"}
                  onPress={() => patchContract({ docker: { ...contract.docker, network: mode } })}
                >
                  {mode}
                </Button>
              ))}
            </div>
            <p className="text-muted mt-1 text-[11px]">
              <span className="font-mono">project</span> isola il progetto con i suoi servizi;{" "}
              <span className="font-mono">host</span> condivide lo stack di rete della macchina.
            </p>
          </div>

          <div>
            <span className="text-muted mb-2 block text-sm font-medium">Riavvio</span>
            <div className="flex flex-wrap gap-2">
              {(["no", "on-failure", "unless-stopped", "always"] as const).map((policy) => (
                <Button
                  key={policy}
                  size="sm"
                  variant={contract.runtime.restartPolicy === policy ? "primary" : "outline"}
                  onPress={() => patchContract({ runtime: { ...contract.runtime, restartPolicy: policy } })}
                >
                  {policy}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              value={contract.runtime.memory ?? ""}
              onChange={(v) => patchContract({ runtime: { ...contract.runtime, memory: v || undefined } })}
            >
              <Label>Memoria</Label>
              <Input placeholder="2g" className="font-mono text-sm" />
            </TextField>
            <TextField
              value={contract.runtime.cpus ?? ""}
              onChange={(v) => patchContract({ runtime: { ...contract.runtime, cpus: v || undefined } })}
            >
              <Label>CPU</Label>
              <Input placeholder="1.5" className="font-mono text-sm" />
            </TextField>
            <TextField
              value={contract.runtime.shmSize ?? ""}
              onChange={(v) => patchContract({ runtime: { ...contract.runtime, shmSize: v || undefined } })}
            >
              <Label>shm-size</Label>
              <Input placeholder="2g" className="font-mono text-sm" />
            </TextField>
          </div>

          <TextField
            value={contract.docker.hostname ?? ""}
            onChange={(v) => patchContract({ docker: { ...contract.docker, hostname: v || undefined } })}
          >
            <Label>Hostname</Label>
            <Input placeholder="127.0.0.1" className="font-mono text-sm" />
          </TextField>
        </Panel>
      )}

      <div className="flex justify-end">
        <Button variant="primary" isPending={saving} onPress={save}>
          Salva modifiche
        </Button>
      </div>

      <Panel className="space-y-4">
        <PanelHeader title="Webhook" description="Deploy automatico a ogni push" />

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-foreground text-sm">Auto-deploy</p>
            <p className="text-muted text-xs">
              Un push che arriva durante un deploy viene messo in coda, non scartato.
            </p>
          </div>
          <Toggle
            checked={Boolean(project.auto_deploy)}
            label="Attiva auto-deploy"
            onChange={toggleAutoDeploy}
          />
        </div>

        <CopyField label="URL" value={webhookUrl} />
        <CopyField label="Secret" value={project.webhook_secret} secret />
      </Panel>

      <Panel className="border-danger/30 space-y-3">
        <PanelHeader title="Rimuovi l'app" description="Il progetto e i suoi servizi restano" />
        <p className="text-muted text-xs">
          Ferma il processo, elimina i file sorgente, le immagini Docker costruite e la cronologia
          dei deploy.
        </p>
        <Button variant="danger" onPress={() => setConfirmRemoveApp(true)}>
          <Icon icon="solar:trash-bin-trash-linear" width={18} aria-hidden />
          Rimuovi app
        </Button>
      </Panel>

      <ConfirmDialog
        isOpen={confirmRemoveApp}
        onOpenChange={setConfirmRemoveApp}
        destructive
        title="Rimuovere l'app?"
        confirmLabel="Rimuovi"
        description="Processo, file, immagini Docker e cronologia dei deploy verranno eliminati. Il progetto e i suoi servizi restano."
        onConfirm={async () => {
          const res = await fetch(`/api/projects/${project.id}/app`, { method: "DELETE" });
          if (res.ok) {
            toast.success("App rimossa");
            router.push("/home");
          } else {
            toast.error("Rimozione fallita");
          }
        }}
      />
    </div>
  );
}
