"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { toast } from "sonner";
import { MSG } from "@/lib/copy";
import { useResource } from "@/lib/hooks/useResource";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { Segmented } from "@/components/ui/Segmented";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { StickySaveBar } from "@/components/ui/StickySaveBar";
import { DangerZone } from "@/components/ui/DangerAction";
import { InfoTip } from "@/components/ui/Tooltip";
import { Code, FieldHint } from "@/components/ui/Hint";
import { CommandField } from "@/components/ui/CommandField";
import { EnvFilePathHint, HealthcheckHint, PortHint } from "@/components/DeployHints";
import { AccessSection } from "@/components/AccessSection";
import { MountsSection } from "./MountsSection";
import { OneTimeCommandsSection } from "./OneTimeCommandsSection";
import { RepoPathSection } from "./RepoPathSection";
import { WebhookSection } from "./WebhookSection";
import { parseContractJson, type DeployContract } from "@/lib/deploy-contract";
import type { RuntimeType } from "@/lib/validation";
import type { Project } from "./types";

/** The saved state, so "unsaved changes" is a fact rather than a guess. */
function snapshot(
  appName: string,
  branch: string,
  port: string,
  runtimeType: string,
  contract: DeployContract
): string {
  return JSON.stringify({ appName, branch, port, runtimeType, contract });
}

interface Preset {
  id: string;
  label: string;
  description: string;
  runtime: RuntimeType;
  commands: { install?: string; build?: string; start?: string };
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
  const [runtimeType, setRuntimeType] = useState<string>(project.runtime_type);
  const [saving, setSaving] = useState(false);

  /*
    Re-read the contract when the row genuinely changes.

    The form holds a copy from the moment it mounted, and until now nothing else
    wrote that column while it was open. The mount editor below does: it saves
    through its own route, because applying a bind copies bytes and restarts the
    app. Without this, the next Salva would send the contract from before that
    save and quietly put the old mount list back.

    Compared against a baseline so an unchanged poll is a no-op, and adjusted
    during render rather than in an effect — which is what React recommends for
    state derived from props, and what `AccessSection` already does.
  */
  const [storedContract, setStoredContract] = useState(project.builder_config);
  if (project.builder_config !== storedContract) {
    setStoredContract(project.builder_config);
    setContract(parseContractJson(project.builder_config));
  }

  /*
    Which preset the operator is looking at. Local only — nothing about it is
    saved. It drives the suggestions and it is what "Applica" copies from; the
    project keeps no memory of having been built from a preset, and pretending
    otherwise would be a column that goes stale the first time a command is
    edited by hand.
  */
  const [presetId, setPresetId] = useState<string | null>(null);
  const { data: presetData } = useResource<{ presets: Preset[] }>("/api/presets");
  const presets = presetData?.presets ?? [];
  const preset = presets.find((entry) => entry.id === presetId) ?? null;

  // What the server last confirmed. Compared against the live values, so the
  // save bar appears on the first edit and leaves again if it is undone.
  const [saved, setSaved] = useState(() =>
    snapshot(
      project.app_name ?? "",
      project.source_branch,
      project.port?.toString() ?? "",
      project.runtime_type,
      parseContractJson(project.builder_config)
    )
  );
  const current = snapshot(appName, branch, port, runtimeType, contract);
  const dirty = current !== saved;

  const isDocker = runtimeType === "docker";

  function patchContract(patch: Partial<DeployContract>) {
    setContract((prev) => ({ ...prev, ...patch }));
  }

  function reset() {
    const restored = JSON.parse(saved) as {
      appName: string;
      branch: string;
      port: string;
      runtimeType: string;
      contract: DeployContract;
    };
    setAppName(restored.appName);
    setBranch(restored.branch);
    setPort(restored.port);
    setRuntimeType(restored.runtimeType);
    setContract(restored.contract);
  }

  /**
   * Copy a preset's commands into the form.
   *
   * The three fields are replaced wholesale rather than merged: applying
   * "Python" and keeping a leftover `npm run build` from before is exactly the
   * mismatch this is meant to end. Nothing is written until Salva, and Annulla
   * puts everything back, so replacing is safe to offer.
   *
   * The runtime comes with them, because they are not independent choices. The
   * node builder reads `package.json` before it looks at the commands it was
   * given, so pip commands on a Node project fail on a file that isn't there —
   * a preset that set the commands and left the runtime alone would be handing
   * out a broken configuration.
   */
  function applyPreset(chosen: Preset) {
    patchContract({
      commands: {
        ...contract.commands,
        install: chosen.commands.install ?? "",
        build: chosen.commands.build ?? "",
        start: chosen.commands.start ?? "",
      },
    });
    setRuntimeType(chosen.runtime);
    toast.success(`Comandi di "${chosen.label}" applicati — controlla e salva`);
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
    if (runtimeType === "compose") {
      return "Le porte le pubblica il tuo compose file. RunPanel non lo riscrive: per limitare l'accesso metti il binding su 127.0.0.1 lì.";
    }
    if (isDocker && contract.docker.network === "host") {
      return "Con rete host il container condivide la rete della macchina: non c'è una porta pubblicata da spostare. Passa a bridge o project.";
    }
    if (!project.port) {
      return "Questo progetto non ha una porta configurata, quindi non c'è niente da limitare.";
    }
    return undefined;
  }, [runtimeType, project.port, isDocker, contract.docker.network]);

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
          // Sent because applying a preset can change it. Unchanged otherwise,
          // and the route treats an identical value as no change.
          runtimeType,
          builderConfig: contract,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success("Impostazioni salvate");
        setSaved(current);
        onProjectChange(data);
      } else {
        // Details first: "Dati non validi" does not say which field, and the
        // branch name is now validated — an empty one has to come back as
        // "Nome del branch non valido" rather than as a shrug.
        toast.error(data.details?.[0]?.message ?? data.error ?? MSG.saveFailed);
      }
    } catch {
      toast.error(MSG.saveFailed);
    } finally {
      setSaving(false);
    }
  }

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
            <PortHint runtimeType={runtimeType} />
          </div>
        </div>
      </Panel>

      <Section title="Build e avvio" summary={buildSummary} defaultExpanded={hasCustomCommands}>
        {presets.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-1">
              <span className="text-muted text-sm font-medium">Punto di partenza</span>
              <InfoTip title="Preset">
                Una configurazione già pronta per una forma di repository comune. Sceglierne uno
                qui non cambia niente da solo: mostra i comandi che userebbe, e li scrive nei
                campi solo se premi Applica.
              </InfoTip>
            </div>
            <Segmented
              label="Preset di deploy"
              value={presetId ?? "none"}
              onChange={(id) => setPresetId(id === "none" ? null : id)}
              options={[
                { value: "none", label: "Nessuno" },
                ...presets.map((entry) => ({ value: entry.id, label: entry.label })),
              ]}
            />
            {preset && (
              <div className="mt-2 space-y-2">
                <FieldHint className="mt-0">{preset.description}</FieldHint>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" onPress={() => applyPreset(preset)}>
                    Applica i comandi
                  </Button>
                  {preset.runtime !== runtimeType && (
                    <span className="text-warning text-meta">
                      Cambia anche il runtime: <Code>{runtimeType}</Code> → <Code>{preset.runtime}</Code>
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {runtimeType === "node" && (
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
                Con un preset scelto il suggerimento è il suo; senza, il
                ripiego per un runtime non-node è Python, ed è la forma con il
                venv. Diceva `pip install -r requirements.txt`, che su Debian 12
                e Ubuntu 23.04 in su non funziona — PEP 668 marca il Python di
                sistema come externally-managed e pip rifiuta. Il preset lo
                sapeva già; questo campo diceva il contrario, ed è il testo che
                si copia.
              */
              placeholder={
                preset
                  ? (preset.commands.install ?? "")
                  : runtimeType === "node"
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
                preset
                  ? (preset.commands.build ?? "")
                  : runtimeType === "node"
                    ? "rilevato automaticamente"
                    : "go build -o app ."
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
                preset
                  ? (preset.commands.start ?? "")
                  : runtimeType === "node"
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
        Comandi che girano una volta sola, subito sotto quelli che girano
        sempre: sono la stessa materia vista dall'altro lato, e la domanda
        che porta qui ("dove metto questo comando?") ha le due risposte
        una accanto all'altra.

        Fuori dal guard `isDocker` perché vale per ogni runtime, e con un
        salvataggio proprio come i bind: questa coda cambia da sola mentre
        un deploy gira, e non è una cosa che un campo di form possa essere.
      */}
      <OneTimeCommandsSection
        projectId={project.id}
        runtimeType={runtimeType}
        queued={project.oneTimeCommands ?? []}
        isDeploying={project.status === "deploying"}
        onChanged={() => onProjectChange({ ...project })}
      />

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
          <EnvFilePathHint runtimeType={runtimeType} />
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

          <MountsSection
            projectId={project.id}
            mounts={project.mounts ?? []}
            onApplied={() => onProjectChange({ ...project })}
          />
        </Section>
      )}

      {/*
        Native only, and the counterpart of the Container section above: a
        project in a container keeps its files in an image and has binds
        instead, so the two never both appear.
      */}
      {!isDocker && runtimeType !== "compose" && project.repo_location && (
        <RepoPathSection
          projectId={project.id}
          location={project.repo_location}
          repoPath={project.repo_path}
          move={project.repoMove}
          onChanged={() => onProjectChange({ ...project })}
        />
      )}

      <WebhookSection project={project} onProjectChange={onProjectChange} />

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
