"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Button, Input, Label, TextField } from "@heroui/react";
import { toast } from "sonner";
import { Section } from "@/components/ui/Section";
import { Segmented } from "@/components/ui/Segmented";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { CommandField } from "@/components/ui/CommandField";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { InfoTip } from "@/components/ui/Tooltip";
import { useResource } from "@/lib/hooks/useResource";
import {
  DEFAULT_PRE_BACKUP_TIMEOUT_SEC,
  EXCLUDE_PATH_RULE,
  normalizeExcludePath,
  parseBackupSettings,
  type ProjectBackupSettings,
  type VolumeConsistency,
} from "@/lib/backup-settings";
import type { Project } from "./types";

/**
 * How this project's volumes go into a backup.
 *
 * Saved on its own, like the scheduled restart, rather than through the sticky
 * bar: none of it touches the deploy, and a policy reads it at 03:00 whether or
 * not the settings form was saved. The closed summary is read from the row, so
 * opening the tab asks Docker nothing; the volumes, who mounts them and which
 * policies cover them are fetched only once the section is opened.
 */

interface BackupView {
  settings: ProjectBackupSettings;
  docker: boolean;
  volumes: {
    name: string;
    origin: "runpanel" | "compose";
    composeVolume: string | null;
    users: { name: string; state: string; rw: boolean; owned: boolean }[];
  }[];
  services: string[];
  coverage: { id: string; name: string; enabled: boolean; scheduled: boolean }[];
}

const CONSISTENCY_LABELS: Record<VolumeConsistency, string> = {
  pause: "pausa durante la copia",
  live: "copia a caldo",
};

function summarize(settings: ProjectBackupSettings): string {
  const excluded = Object.values(settings.excludes).reduce((total, list) => total + list.length, 0);
  return [
    CONSISTENCY_LABELS[settings.consistency],
    settings.preBackup ? `comando pre-backup in ${settings.preBackup.service}` : null,
    excluded > 0 ? `${excluded} percors${excluded === 1 ? "o escluso" : "i esclusi"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function BackupSection({
  project,
  onSaved,
}: {
  project: Project;
  onSaved: (backupSettings: string) => void;
}) {
  const stored = useMemo(() => parseBackupSettings(project.backup_settings), [project.backup_settings]);

  const [expanded, setExpanded] = useState(false);
  const { data: view, loading } = useResource<BackupView>(
    expanded ? `/api/projects/${project.id}/backup` : null
  );

  const [consistency, setConsistency] = useState<VolumeConsistency>(stored.consistency);
  const [hookEnabled, setHookEnabled] = useState(stored.preBackup !== null);
  const [service, setService] = useState(stored.preBackup?.service ?? "");
  const [command, setCommand] = useState(stored.preBackup?.command ?? "");
  const [timeout, setTimeoutSec] = useState(
    String(stored.preBackup?.timeoutSec ?? DEFAULT_PRE_BACKUP_TIMEOUT_SEC)
  );
  /** One textarea per volume, one path per line. */
  const [excludes, setExcludes] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(stored.excludes).map(([volume, list]) => [volume, list.join("\n")]))
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /*
    Re-sync only when the stored value actually changes. The page hands this a
    fresh row on every poll; resetting on each one would wipe a half-typed
    path. Adjusted during render, as `MountsSection` does.
  */
  const [baseline, setBaseline] = useState(project.backup_settings);
  if (project.backup_settings !== baseline) {
    setBaseline(project.backup_settings);
    setConsistency(stored.consistency);
    setHookEnabled(stored.preBackup !== null);
    setService(stored.preBackup?.service ?? "");
    setCommand(stored.preBackup?.command ?? "");
    setTimeoutSec(String(stored.preBackup?.timeoutSec ?? DEFAULT_PRE_BACKUP_TIMEOUT_SEC));
    setExcludes(
      Object.fromEntries(Object.entries(stored.excludes).map(([volume, list]) => [volume, list.join("\n")]))
    );
  }

  const services = view?.services ?? [];
  const serviceChoices = service && !services.includes(service) ? [service, ...services] : services;
  const canHook = serviceChoices.length > 0;

  /** The first line that would be refused, so the form can point at it. */
  const invalid =
    Object.entries(excludes)
      .flatMap(([volume, text]) => lines(text).map((line) => ({ volume, line })))
      .find(({ line }) => normalizeExcludePath(line) === null) ?? null;

  async function save() {
    if (invalid) {
      setError(`«${invalid.line}» non è un percorso valido. ${EXCLUDE_PATH_RULE}`);
      return;
    }
    const timeoutSec = Number.parseInt(timeout, 10);
    if (hookEnabled && (!service || !command.trim())) {
      setError("Scegli il servizio e scrivi il comando da eseguire prima del backup");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/backup`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consistency,
          preBackup: hookEnabled
            ? {
                service,
                command,
                timeoutSec: Number.isFinite(timeoutSec) ? timeoutSec : DEFAULT_PRE_BACKUP_TIMEOUT_SEC,
              }
            : null,
          excludes: Object.fromEntries(
            Object.entries(excludes)
              .map(([volume, text]) => [volume, lines(text)] as const)
              .filter(([, list]) => list.length > 0)
          ),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Salvataggio non riuscito");
      setError(null);
      onSaved(JSON.stringify(body.settings));
      toast.success("Impostazioni di backup salvate");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Salvataggio non riuscito");
    } finally {
      setSaving(false);
    }
  }

  const coverage = view?.coverage ?? [];
  const active = coverage.filter((policy) => policy.enabled);

  return (
    <Section
      title="Backup dei volumi"
      summary={summarize(stored)}
      onExpandedChange={setExpanded}
    >
      {view && active.length === 0 && (
        <Hint tone="warn" title="Nessuna pianificazione salva questi volumi">
          Le impostazioni qui sotto valgono quando una pianificazione include il progetto con{" "}
          <Code>volumi Docker</Code>. Aggiungilo da{" "}
          <Link href="/backups" className="text-accent hover:underline">
            Backup
          </Link>
          .
        </Hint>
      )}
      {view && active.length > 0 && (
        <FieldHint>
          Salvati da: {active.map((policy) => `${policy.name}${policy.scheduled ? "" : " (solo su richiesta)"}`).join(", ")}
        </FieldHint>
      )}

      <div>
        <div className="mb-2 flex items-center gap-1">
          <span className="text-muted text-sm font-medium">Durante la copia</span>
          <InfoTip title="Perché la pausa">
            Copiare un volume mentre l&apos;app ci scrive può dare un database con i file presi in
            momenti diversi: si ripristina senza errori e poi è rotto. Con la pausa, i container del
            progetto che scrivono in quel volume restano congelati solo per il tempo della lettura: la
            copia va sul disco non compressa, e la compressione avviene dopo, a container ripresi. Il
            risultato è quello che lascerebbe un&apos;interruzione di corrente, da cui SQLite e Postgres
            si riprendono da soli.
          </InfoTip>
        </div>
        <Segmented
          label="Durante la copia"
          value={consistency}
          onChange={setConsistency}
          options={[
            { value: "pause", label: "Metti in pausa chi scrive" },
            { value: "live", label: "Copia a caldo" },
          ]}
        />
        <FieldHint>
          {consistency === "pause"
            ? "Il log del backup dice chi è stato messo in pausa e per quanto. Un container di un altro progetto che usa lo stesso volume non viene mai toccato: la copia viene segnata come non garantita."
            : "Nessuna pausa. Senza un comando pre-backup che prepari i dati, la copia può essere incoerente, e il log e il manifest lo dicono ogni volta."}
        </FieldHint>
      </div>

      {(canHook || hookEnabled) && (
        <div className="space-y-3">
          <SettingToggle
            label="Comando prima del backup"
            description="Eseguito una volta per backup in un servizio dello stack, prima di copiare i volumi"
            isSelected={hookEnabled}
            onChange={setHookEnabled}
          />
          {hookEnabled && (
            <>
              <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                <div>
                  <label className="text-muted mb-1 block text-sm font-medium" htmlFor={`prebackup-${project.id}`}>
                    Servizio
                  </label>
                  <select
                    id={`prebackup-${project.id}`}
                    value={service}
                    onChange={(event) => setService(event.target.value)}
                    className="border-border bg-surface text-foreground h-9 w-full rounded-[var(--radius)] border px-2 text-sm"
                  >
                    <option value="">Scegli…</option>
                    {serviceChoices.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
                <TextField value={timeout} onChange={setTimeoutSec}>
                  <Label>Timeout (s)</Label>
                  <Input inputMode="numeric" />
                </TextField>
              </div>
              <CommandField
                label="Comando"
                value={command}
                onChange={setCommand}
                rows={3}
                placeholder={`sqlite3 /app/data/app.sqlite ".backup /app/data/backup/app.sqlite"`}
                hint={
                  <>
                    Eseguito con <Code>sh -c</Code> nel container del servizio, che deve essere in
                    esecuzione. Se fallisce e la copia è in pausa, il backup prosegue; se la copia è a
                    caldo, il volume non viene salvato.
                  </>
                }
              />
            </>
          )}
        </div>
      )}

      <div className="space-y-3">
        <span className="text-muted text-sm font-medium">Volumi</span>
        {loading && !view && <FieldHint>Chiedo a Docker…</FieldHint>}
        {view && !view.docker && (
          <Hint tone="warn">Docker non è raggiungibile: l&apos;elenco dei volumi non è disponibile.</Hint>
        )}
        {view?.docker && view.volumes.length === 0 && (
          <FieldHint>Nessun volume: questo progetto non ha dati in volumi Docker.</FieldHint>
        )}
        {view?.volumes.map((volume) => {
          const writers = volume.users.filter((user) => user.rw).map((user) => user.name);
          return (
            <div key={volume.name} className="border-border space-y-2 rounded-[var(--radius)] border p-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Code>{volume.name}</Code>
                <span className="text-muted text-meta">
                  {volume.origin === "compose"
                    ? `Compose${volume.composeVolume ? ` · ${volume.composeVolume}` : ""}`
                    : "RunPanel"}
                </span>
                {writers.length > 0 && (
                  <span className="text-muted text-meta">scrivono: {writers.join(", ")}</span>
                )}
              </div>
              <CommandField
                label="Percorsi esclusi"
                value={excludes[volume.name] ?? ""}
                onChange={(value) => setExcludes((current) => ({ ...current, [volume.name]: value }))}
                rows={2}
                placeholder="trades"
              />
            </div>
          );
        })}
        <FieldHint>
          Uno per riga, relativi alla radice del volume: <Code>trades</Code> esclude la cartella e tutto
          quello che contiene. Il log e il manifest dicono cosa è stato escluso e quanto pesava. Al
          ripristino quei percorsi restano come sono: l&apos;archivio non li contiene, quindi non li
          sovrascrive né li cancella. {EXCLUDE_PATH_RULE}.
        </FieldHint>
      </div>

      {error && (
        <p className="text-danger text-xs" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end">
        <Button variant="primary" size="sm" isPending={saving} onPress={() => void save()}>
          Salva impostazioni di backup
        </Button>
      </div>
    </Section>
  );
}
