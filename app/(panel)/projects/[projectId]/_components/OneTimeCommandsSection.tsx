"use client";

import { useMemo, useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { MSG } from "@/lib/copy";
import { formatDurationBetween, formatWhen } from "@/lib/format";
import { useResource } from "@/lib/hooks/useResource";
import { Section } from "@/components/ui/Section";
import { CommandField } from "@/components/ui/CommandField";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { DeleteButton } from "@/components/ui/DangerAction";
import { SelectField } from "@/components/ui/SelectField";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { FormError } from "@/components/ui/FormError";
import {
  DEFAULT_PHASE,
  DEPLOY_PHASES,
  phaseAvailable,
  phaseLabel,
  phaseRunsInContainer,
  phaseUnavailableReason,
  type DeployPhase,
} from "@/lib/deploy-phases";
import type { OneTimeCommand } from "./types";
import { usePendingSave, type RegisterPendingSave } from "./pending-saves";

/**
 * Comandi che girano una volta sola, al punto scelto del prossimo deploy.
 *
 * Salva su una rotta propria e non con la barra delle impostazioni, per la
 * stessa ragione dei bind mount: il form manda tutto il contract a ogni Salva,
 * e questa lista non sta nel contract — non ci puo' stare, perché il contract
 * si fonde con il `runpanel.json` del repository e sarebbe shell arbitraria che
 * chiunque possa pushare riesce a far girare sull'host.
 *
 * L'altra metà del motivo è che la coda cambia da sola: un deploy la svuota
 * mentre qualcuno la sta guardando. Da qui il risync prop→stato in fase di
 * render, e il rifiuto del salvataggio mentre un deploy la tiene.
 */

interface Row {
  /** L'id della riga salvata, assente finchè non è mai stata salvata. */
  id?: string;
  phase: DeployPhase;
  command: string;
  label: string;
  continueOnError: boolean;
  /** Solo per le righe che arrivano dal server. */
  attempts: number;
  errorMessage: string | null;
  blockedReason: string | null;
}

const BLANK = (): Row => ({
  phase: DEFAULT_PHASE,
  command: "",
  label: "",
  continueOnError: false,
  attempts: 0,
  errorMessage: null,
  blockedReason: null,
});

function toRow(command: OneTimeCommand): Row {
  return {
    id: command.id,
    phase: command.phase,
    command: command.command,
    label: command.label ?? "",
    continueOnError: command.continueOnError,
    attempts: command.attempts,
    errorMessage: command.errorMessage,
    blockedReason: command.blockedReason,
  };
}

/** Dove finisce per davvero un comando pinnato qui, in una riga. */
function whereItRuns(phase: DeployPhase, runtimeType: string): string {
  return phaseRunsInContainer(phase, runtimeType)
    ? "Gira in un container usa-e-getta creato dall'immagine appena costruita, con la stessa rete e lo stesso ambiente dell'app."
    : "Gira sull'host, nella cartella del repository, con lo stesso ambiente dell'app.";
}

export function OneTimeCommandsSection({
  projectId,
  runtimeType,
  queued,
  isDeploying,
  onChanged,
  registerPending,
}: {
  projectId: string;
  runtimeType: string;
  queued: OneTimeCommand[];
  isDeploying: boolean;
  /** Con la coda appena salvata quando c'è, senza per chiedere di rileggere il progetto. */
  onChanged: (queued?: OneTimeCommand[]) => void;
  /** Passa le modifiche non salvate alla barra di salvataggio della scheda. */
  registerPending?: RegisterPendingSave;
}) {
  const [rows, setRows] = useState<Row[]>(() => queued.map(toRow));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  /*
    Ri-sincronizza solo quando la coda salvata cambia davvero. La pagina passa
    le stesse props a ogni poll, e reimpostare a ogni giro cancellerebbe un
    comando scritto a metà. Aggiustato in fase di render e non in un effetto,
    che è quello che React consiglia per lo stato derivato dalle props — la
    stessa forma di `MountsSection` e `AccessSection`.
  */
  const stored = JSON.stringify(queued);
  const [baseline, setBaseline] = useState(stored);
  if (stored !== baseline) {
    // Righe modificate rispetto alla coda di prima: non si toccano, un deploy
    // che prende in carico la coda non deve cancellare quello che stai
    // scrivendo. Il salvataggio poi risponde 409 se la coda è cambiata.
    const edited =
      JSON.stringify(rows.filter((row) => row.command.trim()).map(toStored)) !==
      JSON.stringify((JSON.parse(baseline) as OneTimeCommand[]).map(toRow).map(toStored));
    setBaseline(stored);
    if (!edited) setRows(queued.map(toRow));
  }

  // La cronologia costa, e nessuno la guarda finchè non la apre.
  const { data: historyData, refresh: refreshHistory } = useResource<{
    history: OneTimeCommand[];
  }>(showHistory ? `/api/projects/${projectId}/one-time-commands?include=history` : null);
  const history = historyData?.history ?? [];

  const filled = rows.filter((row) => row.command.trim());
  // Confrontato su `filled`: una riga appena aggiunta e ancora vuota non è una
  // modifica da salvare, e il salvataggio la scarta comunque.
  const dirty =
    JSON.stringify(filled.map(toStored)) !== JSON.stringify(queued.map(toRow).map(toStored));

  const summary = useMemo(() => {
    if (queued.length === 0) return "Nessuno in coda";
    const phases = [...new Set(queued.map((command) => command.phase))];
    const where =
      phases.length === 1 ? `al passo "${phaseLabel(phases[0])}"` : `su ${phases.length} passi`;
    const blocked = queued.filter((command) => command.blockedReason).length;
    return `${queued.length} in coda · ${where}${blocked > 0 ? ` · ${blocked} bloccato/i` : ""}`;
  }, [queued]);

  const patch = (index: number, change: Partial<Row>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...change } : row)));

  async function save(): Promise<boolean> {
    // Prima il pulsante era spento durante un deploy: la coda è in uso.
    if (isDeploying) {
      setError("Durante un deploy la coda è in uso: salvala quando finisce.");
      return false;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/one-time-commands`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commands: filled.map((row) => ({
            id: row.id,
            phase: row.phase,
            command: row.command,
            label: row.label.trim() || null,
            continueOnError: row.continueOnError,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.details?.[0]?.message ?? data.error ?? MSG.saveFailed);
        if (data.code === "queue-changed") {
          // Le righe tengono id che un deploy ha già preso: si riparte dalla
          // coda attuale, o ogni salvataggio risponderebbe di nuovo 409.
          setRows(queued.map(toRow));
          onChanged();
        }
        return false;
      }
      setError(null);
      // The rows take the ids the server just gave the new commands. Without
      // this a new row kept no id, still differed from the stored queue, and a
      // second save sent it again as another new command.
      if (Array.isArray(data.queued)) setRows((data.queued as OneTimeCommand[]).map(toRow));
      onChanged(Array.isArray(data.queued) ? (data.queued as OneTimeCommand[]) : undefined);
      return true;
    } catch {
      setError(MSG.saveFailed);
      return false;
    } finally {
      setBusy(false);
    }
  }

  usePendingSave(registerPending, "one-time", "Comandi una tantum", dirty, save, () => {
    setRows(queued.map(toRow));
    setError(null);
  });

  async function clearHistory() {
    const res = await fetch(`/api/projects/${projectId}/one-time-commands`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Cronologia svuotata");
      void refreshHistory();
    } else {
      toast.error(MSG.deleteFailed);
    }
  }

  return (
    <Section title="Comandi una tantum" summary={summary} defaultExpanded={queued.length > 0}>
      {isDeploying && (
        <Hint tone="info" title="Deploy in corso">
          La coda è in mano al deploy che sta girando. Potrai modificarla quando ha finito.
        </Hint>
      )}

      {rows.length === 0 ? (
        <FieldHint className="mt-0">
          Nessuno. Ogni deploy esegue soltanto i comandi fissi di questo progetto.
        </FieldHint>
      ) : (
        <div className="space-y-3">
          {rows.map((row, index) => {
            const unavailable = phaseUnavailableReason(row.phase, runtimeType);
            return (
              <div
                key={row.id ?? `new-${index}`}
                className={`space-y-2 rounded-[var(--radius)] border p-3 ${
                  unavailable || row.blockedReason ? "border-warning/35" : "border-border"
                }`}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <SelectField<DeployPhase>
                    label="Quando"
                    value={row.phase}
                    isDisabled={isDeploying}
                    onChange={(phase) => patch(index, { phase })}
                    options={DEPLOY_PHASES.map((phase) => ({
                      value: phase.id,
                      label: phaseAvailable(phase.id, runtimeType)
                        ? phase.label
                        : `${phase.label} — non disponibile con ${runtimeType}`,
                      // Disabilitata e non nascosta: dice che il punto
                      // esiste, e che non esiste per QUESTO runtime.
                      isDisabled: !phaseAvailable(phase.id, runtimeType),
                    }))}
                  />

                  <TextField
                    value={row.label}
                    onChange={(value) => patch(index, { label: value })}
                    isDisabled={isDeploying}
                    aria-label="Nome del comando"
                  >
                    <Input placeholder="nome (facoltativo)" />
                  </TextField>
                </div>

                <CommandField
                  value={row.command}
                  isDisabled={isDeploying}
                  placeholder="npx prisma migrate resolve --applied 2024_init"
                  onChange={(value) => patch(index, { command: value })}
                  hint={
                    <>
                      {DEPLOY_PHASES.find((phase) => phase.id === row.phase)?.description}{" "}
                      {whereItRuns(row.phase, runtimeType)}
                    </>
                  }
                />

                <div className="flex flex-wrap items-center gap-4">
                  <CheckboxField
                    label="Continua anche se fallisce"
                    isSelected={row.continueOnError}
                    isDisabled={isDeploying}
                    onChange={(continueOnError) => patch(index, { continueOnError })}
                  />
                  <div className="ml-auto">
                    {/*
                      Nessuna conferma: la riga esce dallo stato locale e non
                      succede niente finchè non premi Salva. Chiedere due volte
                      per qualcosa che un Annulla già disfa è esattamente
                      quello che insegna a chiudere le conferme senza leggerle.
                    */}
                    <Button
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      isDisabled={isDeploying}
                      aria-label={`Rimuovi ${row.label || "comando"}`}
                      onPress={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <Icon icon="solar:trash-bin-trash-linear" width={18} className="text-danger" />
                    </Button>
                  </div>
                </div>

                {unavailable && (
                  <Hint tone="warn" title="Questo passo non esiste con il runtime attuale">
                    {unavailable}
                  </Hint>
                )}

                {!unavailable && row.attempts > 0 && row.errorMessage && (
                  <Hint tone="warn" title={`Ultimo tentativo non riuscito (${row.attempts})`}>
                    {row.errorMessage} — resta in coda e riparte al prossimo deploy.
                  </Hint>
                )}
              </div>
            );
          })}
        </div>
      )}

      <FormError>{error}</FormError>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          isDisabled={isDeploying}
          onPress={() => setRows((prev) => [...prev, BLANK()])}
        >
          <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
          Aggiungi un comando
        </Button>
        {/* No save button of its own: the tab's bar saves the queue with the rest. */}
        {busy && <span className="text-muted self-center text-xs">Salvataggio della coda…</span>}
        <Button variant="ghost" size="sm" onPress={() => setShowHistory((open) => !open)}>
          <Icon icon="solar:history-linear" width={16} aria-hidden />
          {showHistory ? "Nascondi la cronologia" : "Mostra la cronologia"}
        </Button>
      </div>

      <FieldHint>
        Girano una volta sola: quello che riesce esce dalla coda e finisce nella cronologia, e il
        deploy dopo non lo rivede. Se uno fallisce, il deploy fallisce e il comando{" "}
        <strong>resta in coda</strong>, cosi&apos; sistemi la causa e il deploy successivo lo
        riprova — a meno che non spunti &quot;Continua anche se fallisce&quot;, che lo consuma
        comunque. Un comando per riga, eseguiti in ordine nella stessa shell, come nei campi qui
        sopra. Non metterci password: il comando finisce nel log del deploy.{" "}
        {runtimeType === "compose" && (
          <>
            Con Compose girano sempre sull&apos;host: non c&apos;e&apos; una sola immagine da cui
            creare un container, e per entrare in un servizio serve scriverlo a mano —{" "}
            <Code>docker compose run --rm api sh -c &apos;…&apos;</Code>.
          </>
        )}
      </FieldHint>

      {showHistory && (
        <div className="border-separator space-y-2 border-t pt-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted text-sm font-medium">Cronologia</span>
            {history.length > 0 && (
              <DeleteButton
                label="Svuota la cronologia"
                confirm={{
                  title: "Svuotare la cronologia?",
                  confirmLabel: "Svuota",
                  description:
                    "Sparisce solo il registro dei comandi già eseguiti. La coda e i log dei deploy restano come sono.",
                }}
                onConfirm={clearHistory}
              />
            )}
          </div>

          {history.length === 0 ? (
            <FieldHint className="mt-0">
              Ancora niente: qui finiscono i comandi dopo che sono girati.
            </FieldHint>
          ) : (
            <ul className="space-y-1.5">
              {history.map((entry) => (
                <li
                  key={entry.id}
                  className="border-border flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-[var(--radius)] border px-2.5 py-2 text-xs"
                >
                  <span
                    aria-hidden
                    className={`size-1.5 shrink-0 rounded-full ${
                      entry.status === "done" ? "bg-success" : "bg-danger"
                    }`}
                  />
                  <span className="text-foreground font-medium">
                    {entry.label ?? entry.command.split("\n")[0]}
                  </span>
                  <span className="text-muted">{phaseLabel(entry.phase)}</span>
                  <span className="text-muted">{formatWhen(entry.finishedAt)}</span>
                  <span className="text-muted">
                    {formatDurationBetween(entry.startedAt, entry.finishedAt)}
                  </span>
                  {entry.commitSha && (
                    <span className="text-muted font-mono">{entry.commitSha.slice(0, 7)}</span>
                  )}
                  {entry.status === "failed" && entry.errorMessage && (
                    <span className="text-danger w-full break-words">{entry.errorMessage}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

/** Solo i campi che l'operatore controlla: il resto è esito, non modifica. */
function toStored(row: Row) {
  return {
    id: row.id ?? null,
    phase: row.phase,
    command: row.command,
    label: row.label.trim(),
    continueOnError: row.continueOnError,
  };
}
