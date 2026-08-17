"use client";

import { useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { DeleteButton } from "@/components/ui/DangerAction";
import {
  CONTAINER_PATH_RULE,
  HOST_PATH_RULE,
  containerPathSchema,
  hostPathSchema,
} from "@/lib/validation";

/**
 * The folders of a project's container, published on the host.
 *
 * `docker.mounts` has been in the deploy contract from the beginning and has
 * always reached `docker run -v` — panel-only, so a repository cannot grant
 * itself a bind of `/` or of the Docker socket. What it never had is this: a way
 * to set it that is not hand-writing the contract.
 *
 * It saves through its own route rather than the settings form's sticky bar, and
 * not for tidiness. Saving here stops the app, copies what the container has at
 * that path into the host directory, and restarts it. A form save must not be
 * able to do that by accident — nor to write a bind with no copy in front of it,
 * which would show the app an empty folder where its files were.
 */

export interface ProjectMountRow {
  source: string;
  target: string;
  readOnly: boolean;
  enabled: boolean;
}

const BLANK = (): ProjectMountRow => ({ source: "", target: "", readOnly: false, enabled: true });

export function MountsSection({
  projectId,
  mounts,
  onApplied,
}: {
  projectId: string;
  mounts: ProjectMountRow[];
  onApplied: () => void;
}) {
  const [rows, setRows] = useState<ProjectMountRow[]>(mounts);
  const [error, setError] = useState<string | null>(null);
  const [notEmpty, setNotEmpty] = useState<{ target: string; entries: string[] } | null>(null);
  const [adopt, setAdopt] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  /*
    Re-sync only when the stored list actually changes. The page hands this the
    same props on every poll; resetting on each one would wipe a half-typed
    path. Adjusted during render rather than in an effect, which is what React
    recommends for state derived from props.
  */
  const stored = JSON.stringify(mounts);
  const [baseline, setBaseline] = useState(stored);
  if (stored !== baseline) {
    setBaseline(stored);
    setRows(mounts);
  }

  const filled = rows.filter((row) => row.source.trim() || row.target.trim());

  const patch = (index: number, change: Partial<ProjectMountRow>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...change } : row)));

  async function save() {
    for (const row of filled) {
      const source = hostPathSchema.safeParse(row.source);
      if (!source.success) {
        setError(source.error.issues[0]?.message ?? HOST_PATH_RULE);
        return;
      }
      const target = containerPathSchema.safeParse(row.target);
      if (!target.success) {
        setError(target.error.issues[0]?.message ?? CONTAINER_PATH_RULE);
        return;
      }
    }

    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/mounts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mounts: filled, adopt }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409 && data.code === "destination-not-empty") {
        setNotEmpty({ target: data.target, entries: data.entries ?? [] });
        setError(data.error ?? null);
        return;
      }
      if (!res.ok) {
        setError(data.details?.[0]?.message ?? data.error ?? "Applicazione non riuscita");
        return;
      }
      setError(null);
      setNotEmpty(null);
      setAdopt([]);
      onApplied();
    } catch {
      setError("Applicazione non riuscita");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-separator space-y-3 border-t pt-4">
      <div className="flex items-center gap-1">
        <span className="text-muted text-sm font-medium">Cartelle condivise con l&apos;host</span>
      </div>

      {rows.length === 0 ? (
        <FieldHint>
          Nessuna. Il container vede solo quello che c&apos;è nella sua immagine.
        </FieldHint>
      ) : (
        <div className="space-y-3">
          {rows.map((row, index) => (
            <div key={index} className="border-border space-y-2 rounded-[var(--radius)] border p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <TextField
                  value={row.source}
                  onChange={(v) => patch(index, { source: v })}
                  aria-label="Cartella sull'host"
                >
                  <Input placeholder="cartella sull'host" />
                </TextField>
                <TextField
                  value={row.target}
                  onChange={(v) => patch(index, { target: v })}
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
                    onChange={(e) => patch(index, { enabled: e.target.checked })}
                    className="accent-accent size-4"
                  />
                  Attivo
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={row.readOnly}
                    onChange={(e) => patch(index, { readOnly: e.target.checked })}
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
                    onConfirm={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                  />
                </div>
              </div>

              {notEmpty?.target === row.target && (
                <Hint tone="warn" title="La cartella sull'host non è vuota">
                  Contiene {notEmpty.entries.slice(0, 5).join(", ")}
                  {notEmpty.entries.length > 5 ? "…" : ""}. Se è già il contenuto giusto, spunta la
                  casella: il pannello la monta com&apos;è, senza copiarci sopra niente.
                  <label className="mt-2 flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={adopt.includes(row.target)}
                      onChange={(e) =>
                        setAdopt((prev) =>
                          e.target.checked
                            ? [...prev, row.target]
                            : prev.filter((t) => t !== row.target)
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

      {error && !notEmpty && (
        <p className="text-danger text-xs" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onPress={() => setRows((prev) => [...prev, BLANK()])}>
          <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
          Aggiungi una cartella
        </Button>
        <Button variant="primary" size="sm" isPending={busy} onPress={save}>
          Salva e applica
        </Button>
      </div>

      <FieldHint>
        Si salvano da qui e non con il resto delle impostazioni: applicarle ferma l&apos;app, copia
        quello che il container ha a quel percorso dentro la cartella dell&apos;host, e la riavvia. La
        prima volta la copia serve perché un bind da solo <strong>coprirebbe</strong> il contenuto e
        vedresti una cartella vuota. Da lì in poi è la stessa cartella, sottocartelle comprese. Serve
        un deploy prima: la copia legge dall&apos;immagine, e senza non c&apos;è niente da cui leggere.{" "}
        <Code>{HOST_PATH_RULE}</Code>
      </FieldHint>
    </div>
  );
}
