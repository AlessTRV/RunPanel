"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { CopyField } from "@/components/ui/CopyField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import {
  BuildEnvHint,
  EnvFilePathHint,
  HealthcheckHint,
  PortHint,
} from "@/components/DeployHints";
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
  hint?: React.ReactNode;
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

        <div>
          <TextField value={appName} onChange={setAppName}>
            <Label>Nome app</Label>
            <Input placeholder={project.slug} />
          </TextField>
          <FieldHint>
            Solo un&apos;etichetta per il pannello. Container, processo, volumi e cartelle
            continuano a usare lo slug <Code>{project.slug}</Code>, che non cambia più: rinominare
            qui non rompe niente proprio perché non tocca nulla di tutto questo.
          </FieldHint>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <TextField value={branch} onChange={setBranch}>
              <Label>Branch</Label>
              <Input />
            </TextField>
            <FieldHint>
              Cambiarlo ha effetto dal prossimo deploy, non subito: il checkout attuale resta
              quello che è finché non ridistribuisci.
            </FieldHint>
          </div>
          <div>
            <TextField value={port} onChange={setPort}>
              <Label>Porta</Label>
              <Input type="number" placeholder="3000" />
            </TextField>
            <PortHint runtimeType={project.runtime_type} />
          </div>
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
            hint={
              <>
                Eseguito una volta dopo il build e prima dell&apos;avvio. Se fallisce, fallisce il
                deploy e la nuova versione non parte: è il posto giusto per le migrazioni.{" "}
                {isDocker
                  ? "Gira in un container usa-e-getta creato dall'immagine appena costruita, sulla stessa rete e con lo stesso ambiente dell'app — quindi vede il database del progetto."
                  : "Gira nella cartella del repository con lo stesso ambiente dell'app."}
              </>
            }
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
          <>
            <HealthcheckHint />
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
          </>
        )}
      </Panel>

      <Panel className="space-y-4">
        <PanelHeader
          title="Ambiente"
          description="Come le variabili raggiungono build e runtime"
        />

        <BuildEnvHint prefixes={contract.buildEnvPrefixes} />

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
          <div>
            <TextField
              value={contract.envFile.path}
              onChange={(v) => patchContract({ envFile: { ...contract.envFile, path: v } })}
            >
              <Label>Percorso del file</Label>
              <Input placeholder="/app/.env" className="font-mono text-sm" />
            </TextField>
            <EnvFilePathHint runtimeType={project.runtime_type} />
            <FieldHint>
              Il file viene riscritto a ogni deploy con tutte le variabili del progetto: quello che
              modifichi a mano lì dentro sparisce. Il posto giusto per cambiarle è la scheda
              Variabili.
            </FieldHint>
          </div>
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
            <FieldHint>
              <Code>project</Code> mette app e servizi del progetto sulla stessa rete, dove si
              raggiungono per nome del container: è quello che rende automatico il collegamento del
              database. <Code>bridge</Code> lascia l&apos;app sulla rete di default, isolata dai
              servizi. <Code>host</Code> condivide lo stack di rete della macchina: niente porte
              pubblicate, <Code>localhost</Code> dentro il container è già quello dell&apos;host.
            </FieldHint>
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
            <FieldHint>
              <Code>unless-stopped</Code> è il default e nella maggior parte dei casi è quello
              giusto: riparte al riavvio della macchina, ma se sei tu a fermarlo resta fermo. Con{" "}
              <Code>always</Code> un riavvio di Docker lo rimette su anche se l&apos;avevi fermato a
              mano. <Code>no</Code> lo lascia giù dopo ogni crash.
            </FieldHint>
          </div>

          <div>
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
            <FieldHint>
              Formato Docker: <Code>512m</Code>, <Code>2g</Code> per la memoria, un numero anche
              decimale per le CPU (<Code>1.5</Code> = una CPU e mezza). Vuoti significano nessun
              limite. <Code>shm-size</Code> serve solo se dentro gira un browser headless o
              Postgres: il default di 64 MB li fa crashare senza spiegazioni.
            </FieldHint>
          </div>

          <div>
            <TextField
              value={contract.docker.hostname ?? ""}
              onChange={(v) => patchContract({ docker: { ...contract.docker, hostname: v || undefined } })}
            >
              <Label>Hostname</Label>
              <Input placeholder="app" className="font-mono text-sm" />
            </TextField>
            <FieldHint>
              Il nome che il container dà a se stesso (<Code>--hostname</Code>). Serve alle app che
              si annunciano agli altri con il proprio hostname; per raggiungere questo container
              dagli altri basta il nome del container, che non cambia.
            </FieldHint>
          </div>
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

        <Hint tone="tip" title="Come si collega su GitHub">
          Repository → Settings → Webhooks → Add webhook. Incolla URL e Secret qui sopra, metti
          Content type su <Code>application/json</Code> e lascia selezionato il solo evento{" "}
          <Code>push</Code>. La firma viene verificata a ogni chiamata, quindi un Secret sbagliato
          non fa danni: la consegna viene rifiutata e la vedi rossa in &quot;Recent Deliveries&quot;
          su GitHub. Se il pannello non è raggiungibile da internet GitHub non può chiamarlo, e
          resta il pulsante Deploy.
        </Hint>
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
