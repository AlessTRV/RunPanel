"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Input, Label, TextField } from "@heroui/react";
import { toast } from "sonner";
import { MSG } from "@/lib/copy";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { CopyField } from "@/components/ui/CopyField";
import { Segmented } from "@/components/ui/Segmented";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { StickySaveBar } from "@/components/ui/StickySaveBar";
import { DangerZone } from "@/components/ui/DangerAction";
import { InfoTip } from "@/components/ui/Tooltip";
import { Code, FieldHint } from "@/components/ui/Hint";
import { EnvFilePathHint, HealthcheckHint, PortHint } from "@/components/DeployHints";
import { AccessSection } from "@/components/AccessSection";
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
      {hint && <p className="text-muted mt-1 text-meta">{hint}</p>}
    </div>
  );
}

/** The saved state, so "unsaved changes" is a fact rather than a guess. */
function snapshot(appName: string, branch: string, port: string, contract: DeployContract): string {
  return JSON.stringify({ appName, branch, port, contract });
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

  // What the server last confirmed. Compared against the live values, so the
  // save bar appears on the first edit and leaves again if it is undone.
  const [saved, setSaved] = useState(() =>
    snapshot(
      project.app_name ?? "",
      project.source_branch,
      project.port?.toString() ?? "",
      parseContractJson(project.builder_config)
    )
  );
  const current = snapshot(appName, branch, port, contract);
  const dirty = current !== saved;

  const isDocker = project.runtime_type === "docker";

  function patchContract(patch: Partial<DeployContract>) {
    setContract((prev) => ({ ...prev, ...patch }));
  }

  function reset() {
    const restored = JSON.parse(saved) as {
      appName: string;
      branch: string;
      port: string;
      contract: DeployContract;
    };
    setAppName(restored.appName);
    setBranch(restored.branch);
    setPort(restored.port);
    setContract(restored.contract);
  }

  /**
   * What a closed section is currently set to.
   *
   * Without these, closing a section would hide the answer along with the
   * controls — which is hiding information, not reducing it.
   */
  const hasCustomCommands = Boolean(
    contract.commands.install || contract.commands.build || contract.commands.start || contract.commands.release
  );

  const buildSummary = useMemo(() => {
    if (isDocker) {
      return contract.commands.release ? "Dockerfile · con release command" : "Dal Dockerfile del repository";
    }
    // Non "rilevato": la rilevazione avviene nel repository a ogni deploy
    // (`detectPreset`) e il pannello non ne conserva l'esito, quindi un
    // riepilogo al passato dichiara un fatto che non conosce — su un progetto
    // appena creato è semplicemente falso. Dice invece da dove verranno.
    const pm = contract.packageManager === "auto" ? "package manager automatico" : contract.packageManager;
    return hasCustomCommands ? `${pm} · comandi personalizzati` : `${pm} · comandi dal repository`;
  }, [isDocker, contract.packageManager, contract.commands.release, hasCustomCommands]);

  /**
   * Why the access restriction cannot be offered here, when it cannot.
   *
   * Three shapes the panel would have to lie about. A Compose project publishes
   * its ports from a file the operator owns, and rewriting it behind their back
   * is a silent edit to their work. `network: host` gives the container the
   * host's own stack, so there is no port to move. And with no port configured
   * there is nothing published to restrict in the first place.
   */
  const accessUnavailable = useMemo(() => {
    if (project.runtime_type === "compose") {
      return "Le porte le pubblica il tuo compose file. RunPanel non lo riscrive: per limitare l'accesso metti il binding su 127.0.0.1 lì.";
    }
    if (isDocker && contract.docker.network === "host") {
      return "Con rete host il container condivide la rete della macchina: non c'è una porta pubblicata da spostare. Passa a bridge o project.";
    }
    if (!project.port) {
      return "Questo progetto non ha una porta configurata, quindi non c'è niente da limitare.";
    }
    return undefined;
  }, [project.runtime_type, project.port, isDocker, contract.docker.network]);

  const containerSummary = useMemo(() => {
    const limits = [contract.runtime.memory, contract.runtime.cpus].filter(Boolean).join(" · ");
    return `rete ${contract.docker.network} · riavvio ${contract.runtime.restartPolicy}${limits ? ` · ${limits}` : ""}`;
  }, [contract.docker.network, contract.runtime.restartPolicy, contract.runtime.memory, contract.runtime.cpus]);

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
        setSaved(current);
        onProjectChange(data);
      } else {
        toast.error(data.error ?? MSG.saveFailed);
      }
    } catch {
      toast.error(MSG.saveFailed);
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
      toast.error(MSG.updateFailed);
    }
  }

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/webhooks/github/${project.id}`
      : "";

  return (
    <div className="max-w-3xl space-y-4">
      {/*
        One panel open, five sections closed.

        This screen answered six unrelated questions — what the app is, how it
        builds, how health is judged, whether a dotenv is written, how the
        container runs, and how GitHub triggers it — in six identical boxes, all
        expanded, in one scroll. Around thirty controls, of which the three
        anyone opens this tab for were the first three.

        Every section states what it is currently set to, so closing one hides
        the controls and not the answer.
      */}
      <Panel className="space-y-4">
        <PanelHeader title="Applicazione" description="Come si chiama e dove ascolta" />

        <div>
          <TextField value={appName} onChange={setAppName}>
            <Label>Nome app</Label>
            <Input placeholder={project.slug} />
          </TextField>
          <FieldHint>
            Solo un&apos;etichetta. Container, processo, volumi e cartelle continuano a usare lo
            slug <Code>{project.slug}</Code>, che non cambia mai.
          </FieldHint>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <TextField value={branch} onChange={setBranch}>
              <Label>Branch</Label>
              <Input />
            </TextField>
            <FieldHint>Ha effetto dal prossimo deploy, non subito.</FieldHint>
          </div>
          <div>
            <TextField value={port} onChange={setPort}>
              <Label>Porta</Label>
              <Input type="number" placeholder="3000" />
            </TextField>
            <PortHint runtimeType={project.runtime_type} />
          </div>
        </div>
      </Panel>

      <Section title="Build e avvio" summary={buildSummary} defaultExpanded={hasCustomCommands}>
        {project.runtime_type === "node" && (
          <div>
            <span className="text-muted mb-2 block text-sm font-medium">Package manager</span>
            <Segmented
              label="Package manager"
              value={contract.packageManager}
              onChange={(packageManager) => patchContract({ packageManager })}
              options={[
                { value: "auto", label: "Auto" },
                { value: "npm", label: "npm" },
                { value: "bun", label: "bun" },
                { value: "pnpm", label: "pnpm" },
                { value: "yarn", label: "yarn" },
              ]}
            />
          </div>
        )}

        {!isDocker && (
          <div className="space-y-3">
            <CommandField
              label="Comandi di install"
              value={contract.commands.install ?? ""}
              /*
                Il suggerimento era `pip install -r requirements.txt`, che su
                Debian 12 e Ubuntu 23.04 in su non funziona: PEP 668 marca il
                Python di sistema come externally-managed e pip rifiuta. Il
                preset Python del pannello lo sapeva già e crea un venv; questo
                campo diceva il contrario, ed è il testo che si copia.
              */
              placeholder={
                project.runtime_type === "node"
                  ? "rilevato automaticamente"
                  : "python3 -m venv venv\nvenv/bin/pip install -r requirements.txt"
              }
              hint="Un comando per riga, eseguiti in ordine nella stessa shell."
              onChange={(v) => patchContract({ commands: { ...contract.commands, install: v } })}
            />
            <CommandField
              label="Comandi di build"
              value={contract.commands.build ?? ""}
              placeholder={
                project.runtime_type === "node" ? "rilevato automaticamente" : "go build -o app ."
              }
              onChange={(v) => patchContract({ commands: { ...contract.commands, build: v } })}
            />
            <CommandField
              label="Comando di start"
              rows={1}
              value={contract.commands.start ?? ""}
              // Coerente con l'install qui sopra: i tre campi descrivevano tre
              // progetti diversi — install Python, build Go, start Go.
              placeholder={
                project.runtime_type === "node"
                  ? "rilevato automaticamente"
                  : "venv/bin/python -m uvicorn main:app"
              }
              hint="Solo la prima riga viene usata come comando di avvio."
              onChange={(v) => patchContract({ commands: { ...contract.commands, start: v } })}
            />
          </div>
        )}

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
                ? "Gira in un container usa-e-getta creato dall'immagine appena costruita, sulla stessa rete e con lo stesso ambiente dell'app."
                : "Gira nella cartella del repository con lo stesso ambiente dell'app."}
            </>
          }
          onChange={(v) => patchContract({ commands: { ...contract.commands, release: v } })}
        />
      </Section>

      {/*
        The switch sits in the header, outside the trigger: a section can be
        turned on and off without being opened, which is what lets it stay shut.
      */}
      <Section
        title="Health check"
        summary={
          contract.healthcheck.enabled
            ? `${contract.healthcheck.path} · attesa ${contract.healthcheck.startPeriodSec}s · timeout ${contract.healthcheck.timeoutSec}s`
            : "Spento: il deploy riesce appena il processo parte"
        }
        actions={
          <SettingToggle
            label="Attiva health check"
            isSelected={contract.healthcheck.enabled}
            onChange={(v) => patchContract({ healthcheck: { ...contract.healthcheck, enabled: v } })}
            className="w-auto"
          />
        }
      >
        {contract.healthcheck.enabled ? (
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
                    healthcheck: {
                      ...contract.healthcheck,
                      startPeriodSec: Number.parseInt(v, 10) || 0,
                    },
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
                    healthcheck: {
                      ...contract.healthcheck,
                      timeoutSec: Number.parseInt(v, 10) || 30,
                    },
                  })
                }
              >
                <Label>Timeout (s)</Label>
                <Input type="number" />
              </TextField>
            </div>
          </>
        ) : (
          <p className="text-muted text-sm">
            Senza health check, un&apos;app che parte e muore un secondo dopo risulta comunque
            distribuita con successo.
          </p>
        )}
      </Section>

      {/*
        Its own save, deliberately, and outside the sticky bar: this one moves
        the port the app listens on, so it restarts the app. Bundling it with
        the other settings would make pressing Salva mean "and also restart",
        which is not what the bar has meant anywhere else in the panel.
      */}
      <AccessSection
        kind="project"
        targetId={project.id}
        name={project.name}
        publicPort={project.port}
        access={project.access}
        gate={project.gate}
        unavailable={accessUnavailable}
        onSaved={(updated) => onProjectChange({ ...project, ...(updated as Partial<Project>) })}
      />

      <Section
        title="File .env"
        summary={
          contract.envFile.enabled ? contract.envFile.path : "Le variabili arrivano solo da process.env"
        }
        actions={
          <SettingToggle
            label="Scrivi un file .env"
            isSelected={contract.envFile.enabled}
            onChange={(v) => patchContract({ envFile: { ...contract.envFile, enabled: v } })}
            className="w-auto"
          />
        }
      >
        <div>
          <TextField
            value={contract.envFile.path}
            onChange={(v) => patchContract({ envFile: { ...contract.envFile, path: v } })}
            isDisabled={!contract.envFile.enabled}
          >
            <Label>Percorso del file</Label>
            <Input placeholder="/app/.env" className="font-mono text-sm" />
          </TextField>
          <EnvFilePathHint runtimeType={project.runtime_type} />
          <FieldHint>
            Riscritto a ogni deploy con tutte le variabili del progetto: quello che modifichi lì a
            mano sparisce. Il posto giusto è la scheda Variabili.
          </FieldHint>
        </div>
      </Section>

      {isDocker && (
        <Section title="Container" summary={containerSummary}>
          <div>
            <div className="mb-2 flex items-center gap-1">
              <span className="text-muted text-sm font-medium">Rete</span>
              <InfoTip title="Rete del container">
                <Code>project</Code> mette app e servizi sulla stessa rete, dove si raggiungono per
                nome del container: è quello che rende automatico il collegamento del database.{" "}
                <Code>bridge</Code> lascia l&apos;app isolata dai servizi. <Code>host</Code>{" "}
                condivide lo stack di rete della macchina: niente porte pubblicate, e{" "}
                <Code>localhost</Code> dentro il container è già quello dell&apos;host.
              </InfoTip>
            </div>
            <Segmented
              label="Rete del container"
              value={contract.docker.network}
              onChange={(network) => patchContract({ docker: { ...contract.docker, network } })}
              options={[
                { value: "project", label: "project" },
                { value: "bridge", label: "bridge" },
                { value: "host", label: "host" },
              ]}
            />
          </div>

          <div>
            <div className="mb-2 flex items-center gap-1">
              <span className="text-muted text-sm font-medium">Riavvio</span>
              <InfoTip title="Policy di riavvio">
                <Code>unless-stopped</Code> riparte al riavvio della macchina, ma se sei tu a
                fermarlo resta fermo. <Code>always</Code> lo rimette su anche se l&apos;avevi
                fermato a mano. <Code>no</Code> lo lascia giù dopo ogni crash.
              </InfoTip>
            </div>
            <Segmented
              label="Policy di riavvio"
              value={contract.runtime.restartPolicy}
              onChange={(restartPolicy) =>
                patchContract({ runtime: { ...contract.runtime, restartPolicy } })
              }
              options={[
                { value: "no", label: "no" },
                { value: "on-failure", label: "on-failure" },
                { value: "unless-stopped", label: "unless-stopped" },
                { value: "always", label: "always" },
              ]}
            />
          </div>

          <div>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField
                value={contract.runtime.memory ?? ""}
                onChange={(v) =>
                  patchContract({ runtime: { ...contract.runtime, memory: v || undefined } })
                }
              >
                <Label>Memoria</Label>
                <Input placeholder="2g" className="font-mono text-sm" />
              </TextField>
              <TextField
                value={contract.runtime.cpus ?? ""}
                onChange={(v) =>
                  patchContract({ runtime: { ...contract.runtime, cpus: v || undefined } })
                }
              >
                <Label>CPU</Label>
                <Input placeholder="1.5" className="font-mono text-sm" />
              </TextField>
              <TextField
                value={contract.runtime.shmSize ?? ""}
                onChange={(v) =>
                  patchContract({ runtime: { ...contract.runtime, shmSize: v || undefined } })
                }
              >
                <Label>shm-size</Label>
                <Input placeholder="2g" className="font-mono text-sm" />
              </TextField>
            </div>
            <FieldHint>
              Formato Docker: <Code>512m</Code>, <Code>2g</Code>. Vuoti significano nessun limite.{" "}
              <Code>shm-size</Code> serve solo a browser headless e Postgres, che con il default di
              64 MB crashano senza spiegazioni.
            </FieldHint>
          </div>

          <div>
            <TextField
              value={contract.docker.hostname ?? ""}
              onChange={(v) =>
                patchContract({ docker: { ...contract.docker, hostname: v || undefined } })
              }
            >
              <Label>Hostname</Label>
              <Input placeholder="app" className="font-mono text-sm" />
            </TextField>
            <FieldHint>
              Il nome che il container dà a se stesso. Per raggiungerlo dagli altri basta il nome del
              container, che non cambia.
            </FieldHint>
          </div>
        </Section>
      )}

      <Section
        title="Deploy automatico"
        summary={
          project.auto_deploy
            ? "Attivo: ogni push sul branch fa partire un deploy"
            : "Spento: si distribuisce dal pulsante Deploy"
        }
        actions={
          <SettingToggle
            label="Attiva auto-deploy"
            isSelected={Boolean(project.auto_deploy)}
            onChange={toggleAutoDeploy}
            className="w-auto"
          />
        }
      >
        <CopyField label="URL" value={webhookUrl} />
        <CopyField label="Secret" value={project.webhook_secret} secret />
        <FieldHint>
          Su GitHub: Repository → Settings → Webhooks → Add webhook. Content type{" "}
          <Code>application/json</Code>, e lascia selezionato il solo evento <Code>push</Code>. Una
          firma sbagliata viene rifiutata, quindi un Secret errato non fa danni.
        </FieldHint>
      </Section>

      <StickySaveBar isDirty={dirty} isPending={saving} onSave={save} onReset={reset} />

      {/*
        The two irreversible actions, together and last.

        Deleting the project used to live in the rename overlay — a dialog
        titled "Progetto", opened by a gear icon, which is where someone goes to
        fix a typo in a name. Removing the app was here. Same class of action,
        two unrelated places, and the more destructive of the two was the harder
        one to find.
      */}
      <DangerZone
        title="Rimuovi l'app"
        description="Il progetto e i suoi servizi restano"
        actionLabel="Rimuovi app"
        confirm={{
          title: "Rimuovere l'app?",
          confirmLabel: "Rimuovi",
          description:
            "Processo, file, immagini Docker e cronologia dei deploy verranno eliminati. Il progetto e i suoi servizi restano.",
        }}
        onConfirm={async () => {
          const res = await fetch(`/api/projects/${project.id}/app`, { method: "DELETE" });
          if (res.ok) {
            toast.success("App rimossa");
            router.push("/home");
          } else {
            toast.error(MSG.removeFailed);
          }
        }}
      />

      <DangerZone
        title="Elimina il progetto"
        description="Con i suoi servizi e i loro dati"
        actionLabel="Elimina progetto"
        confirm={{
          title: `Eliminare ${project.name}?`,
          confirmLabel: "Elimina tutto",
          description:
            "Verranno rimossi i processi, i container, le immagini e i volumi dei servizi collegati. I dati dei database non sono recuperabili.",
        }}
        onConfirm={async () => {
          const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
          if (res.ok) {
            toast.success("Progetto eliminato");
            router.push("/home");
          } else {
            toast.error(MSG.deleteFailed);
          }
        }}
      />
    </div>
  );
}
