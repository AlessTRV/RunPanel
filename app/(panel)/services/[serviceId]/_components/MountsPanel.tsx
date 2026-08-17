"use client";

import { useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";
import { DeleteButton } from "@/components/ui/DangerAction";
import {
  CONTAINER_PATH_RULE,
  HOST_PATH_RULE,
  containerPathSchema,
  hostPathSchema,
} from "@/lib/validation";
import type { ServiceMount } from "@/lib/mount";
import type { MountApply, MountPhase } from "@/lib/hooks/useServiceStream";
import type { Service } from "./types";

/**
 * The folders of this service, published where the operator wants them.
 *
 * A bind mount substitutes, it does not merge: the host directory *becomes*
 * that path inside the container, and whatever was there is covered rather than
 * copied out. So the first time a bind is switched on, the panel seeds the
 * empty host directory from what the container has now — and after that there
 * is nothing to keep in step, because it is the same directory.
 *
 * The whole list is applied in one go. Every application recreates the
 * container, so applying row by row would stop the service once per edit.
 */

const PHASE_LABEL: Record<MountPhase, string> = {
  checking: "Controllo le destinazioni…",
  stopping: "Fermo il servizio…",
  seeding: "Copio il contenuto attuale…",
  recreating: "Ricreo il container…",
  verifying: "Aspetto che il motore risponda…",
  "rolling-back": "Torno alla configurazione precedente…",
  done: "Applicato",
  failed: "Non riuscito",
};

const RUNNING: MountPhase[] = [
  "checking", "stopping", "seeding", "recreating", "verifying", "rolling-back",
];

/** Same alphabet as `generateId`, so a row keeps its identity across a save. */
function newId(): string {
  return Math.random().toString(36).slice(2, 14);
}

const BLANK = (): ServiceMount => ({
  id: newId(),
  source: "",
  target: "",
  enabled: true,
  readOnly: false,
});

export function MountsPanel({
  service,
  apply,
  lines,
  progress,
  onApplied,
}: {
  service: Service;
  apply: MountApply | null;
  lines: LogLine[];
  progress: { copiedKb: number; totalKb: number | null } | null;
  onApplied: () => void;
}) {
  const [rows, setRows] = useState<ServiceMount[]>(service.mounts ?? []);
  const [error, setError] = useState<string | null>(null);
  const [notEmpty, setNotEmpty] = useState<{ id: string; entries: string[] } | null>(null);
  const [adopt, setAdopt] = useState<string[]>([]);
  const [releasing, setReleasing] = useState<{ id: string; message: string } | null>(null);
  const [release, setRelease] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const inFlight = apply !== null && RUNNING.includes(apply.phase);

  /*
    Re-sync only when the stored list actually changes.

    The page polls every few seconds and hands this component the same props
    each time; resetting on every one of them would wipe a half-typed path. A
    baseline makes an unchanged poll a no-op, while a genuine change — our own
    save landing, or a rollback putting the previous list back — wins. Adjusted
    during render rather than in an effect, which is what React recommends for
    state derived from props: an effect renders once with the stale value first.
  */
  const stored = JSON.stringify(service.mounts ?? []);
  const [baseline, setBaseline] = useState(stored);
  if (stored !== baseline) {
    setBaseline(stored);
    setRows(service.mounts ?? []);
  }

  const patch = (id: string, change: Partial<ServiceMount>) =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...change } : row)));

  /** A row nobody has filled in yet is not an error, it is a row to drop. */
  const filled = rows.filter((row) => row.source.trim() || row.target.trim());

  function validate(): string | null {
    for (const row of filled) {
      const source = hostPathSchema.safeParse(row.source);
      if (!source.success) return source.error.issues[0]?.message ?? HOST_PATH_RULE;
      const target = containerPathSchema.safeParse(row.target);
      if (!target.success) return target.error.issues[0]?.message ?? CONTAINER_PATH_RULE;
    }
    const targets = filled.filter((r) => r.enabled).map((r) => r.target.replace(/\/+$/, ""));
    const duplicate = targets.find((t, i) => targets.indexOf(t) !== i);
    return duplicate ? `Due bind puntano a ${duplicate} dentro il container.` : null;
  }

  async function save() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`/api/services/${service.id}/mounts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mounts: filled, adopt, releaseData: release }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409 && data.code === "destination-not-empty") {
        // The checkbox appears only once there is something to adopt: offered up
        // front it would read as a shortcut rather than as a decision.
        setNotEmpty({ id: data.mountId, entries: data.entries ?? [] });
        setError(data.error ?? null);
        return;
      }

      if (res.status === 409 && data.code === "data-mount-removed") {
        // Not a checkbox on a row that still exists — the row is the one being
        // taken away — so it is asked here, once, in the words of what happens.
        setReleasing({ id: data.mountId, message: data.error ?? "" });
        setError(null);
        return;
      }
      if (!res.ok) {
        setError(data.details?.[0]?.message ?? data.error ?? "Applicazione non riuscita");
        return;
      }
      setError(null);
      setNotEmpty(null);
      setReleasing(null);
      setAdopt([]);
      setRelease([]);
      onApplied();
    } catch {
      setError("Applicazione non riuscita");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="space-y-4">
      <PanelHeader
        title="Cartelle condivise con l'host"
        description="Una cartella del container, vista dove vuoi tu"
        actions={<Icon icon="solar:folder-linear" width={18} className="text-muted" aria-hidden />}
      />

      {inFlight ? (
        <>
          <Hint tone="warn" title={PHASE_LABEL[apply.phase]}>
            Il servizio è fermo finché l&apos;applicazione non finisce. Il contenuto di partenza non
            viene toccato: se qualcosa va storto il pannello rimette la configurazione precedente.
            {apply.seeding && (
              <>
                {" "}
                Sto seminando <Code>{apply.seeding.target}</Code> in{" "}
                <Code>{apply.seeding.source}</Code>.
              </>
            )}
            {progress && (
              <>
                {" "}
                <strong>
                  {Math.round(progress.copiedKb / 1024)} MB
                  {progress.totalKb ? ` di ${Math.round(progress.totalKb / 1024)} MB` : ""}
                </strong>
              </>
            )}
          </Hint>
          <LogViewer lines={lines} ariaLabel="Log dell'applicazione" className="h-[200px]" />
        </>
      ) : (
        <>
          {apply?.phase === "failed" && (
            <Hint tone="warn" title="L'ultima applicazione non è riuscita">
              {apply.error}{" "}
              {apply.rolledBack
                ? "Il servizio è tornato alla configurazione precedente."
                : "Attenzione: neanche il ritorno indietro è riuscito — controlla lo stato del container."}
            </Hint>
          )}

          {rows.length === 0 ? (
            <FieldHint>
              Nessuna cartella condivisa. Il servizio usa solo il volume che RunPanel gli ha creato.
            </FieldHint>
          ) : (
            <div className="space-y-3">
              {rows.map((row) => (
                <div key={row.id} className="border-border space-y-2 rounded-[var(--radius)] border p-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <TextField
                      value={row.source}
                      onChange={(v) => patch(row.id, { source: v })}
                      aria-label="Cartella sull'host"
                    >
                      <Input placeholder="cartella sull'host" />
                    </TextField>
                    <TextField
                      value={row.target}
                      onChange={(v) => patch(row.id, { target: v })}
                      aria-label="Percorso dentro il container"
                    >
                      <Input placeholder="percorso nel container" />
                    </TextField>
                  </div>

                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex cursor-pointer items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(e) => patch(row.id, { enabled: e.target.checked })}
                        className="accent-accent size-4"
                      />
                      Attivo
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={row.readOnly}
                        onChange={(e) => patch(row.id, { readOnly: e.target.checked })}
                        className="accent-accent size-4"
                      />
                      Sola lettura
                    </label>
                    <div className="ml-auto">
                      <DeleteButton
                        label="Rimuovi questa cartella"
                        confirm={{
                          title: "Rimuovere il bind?",
                          description:
                            "La cartella sull'host resta dov'è con i suoi file: il container smette solo di vederla, e torna a vedere la propria.",
                        }}
                        onConfirm={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                      />
                    </div>
                  </div>

                  {notEmpty?.id === row.id && (
                    <Hint tone="warn" title="La cartella sull'host non è vuota">
                      Contiene {notEmpty.entries.slice(0, 5).join(", ")}
                      {notEmpty.entries.length > 5 ? "…" : ""}. Se è già il contenuto giusto — una
                      installazione precedente, un disco che stai riadottando — spunta la casella: il
                      pannello la monta com&apos;è, senza copiarci sopra niente.
                      <label className="mt-2 flex cursor-pointer items-start gap-2.5">
                        <input
                          type="checkbox"
                          checked={adopt.includes(row.id)}
                          onChange={(e) =>
                            setAdopt((prev) =>
                              e.target.checked
                                ? [...prev, row.id]
                                : prev.filter((id) => id !== row.id)
                            )
                          }
                          className="accent-warning mt-0.5 size-4"
                        />
                        <span className="text-xs leading-relaxed">Usa i dati che ci sono già</span>
                      </label>
                    </Hint>
                  )}
                </div>
              ))}
            </div>
          )}

          {releasing && (
            <Hint tone="warn" title="Stai togliendo il bind sui dati del servizio">
              {releasing.message}
              <label className="mt-2 flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={release.includes(releasing.id)}
                  onChange={(e) =>
                    setRelease((prev) =>
                      e.target.checked
                        ? [...prev, releasing.id]
                        : prev.filter((id) => id !== releasing.id)
                    )
                  }
                  className="accent-danger mt-0.5 size-4"
                />
                <span className="text-xs leading-relaxed">
                  Ho capito: rimetti il servizio sul volume di prima
                </span>
              </label>
            </Hint>
          )}

          {error && !notEmpty && (
            <p className="text-danger text-xs" role="alert">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onPress={() => setRows((prev) => [...prev, BLANK()])}
            >
              <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
              Aggiungi una cartella
            </Button>
            <Button variant="primary" size="sm" isPending={busy} onPress={save}>
              Salva e applica
            </Button>
          </div>

          <FieldHint>
            <strong>{HOST_PATH_RULE}</strong> Il percorso dentro il container è quello che vuoi
            vedere: <Code>/etc/postgresql</Code>, <Code>/var/log</Code>, la directory dati. La prima
            volta che accendi un bind il pannello copia fuori quello che c&apos;è adesso, perché un
            bind da solo lo coprirebbe e vedresti una cartella vuota. Da lì in poi è la stessa
            cartella: modifichi da una parte, cambia dall&apos;altra, sottocartelle comprese.
          </FieldHint>
        </>
      )}
    </Panel>
  );
}
