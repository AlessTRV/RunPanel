"use client";

import { useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { NATIVE_PATH_RULE, nativePathSchema } from "@/lib/validation";

/**
 * Where a native project's files live.
 *
 * A project under PM2 has no container, so it has no binds — it has a directory,
 * and until now no way to put that directory on a different disk. Moving it
 * leaves a symlink at the original location, which is what lets every part of
 * the panel that only ever had a slug keep finding it.
 *
 * Not part of the settings form's Save: this stops the process, copies the
 * checkout and starts it again. A form save must not be able to do that in
 * passing.
 */

const RUNNING = ["checking", "stopping", "seeding", "recreating", "verifying", "rolling-back"];

export interface RepoMove {
  phase: string;
  from: string;
  to: string | null;
  error?: string;
  rolledBack?: boolean;
  leftBehind?: string;
}

export function RepoPathSection({
  projectId,
  location,
  repoPath,
  move,
  onChanged,
}: {
  projectId: string;
  location: { declared: string; real: string | null };
  repoPath: string | null;
  move: RepoMove | null;
  onChanged: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inFlight = move !== null && RUNNING.includes(move.phase);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/repo-path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.details?.[0]?.message ?? data.error ?? "Spostamento non riuscito");
        return;
      }
      setError(null);
      onChanged();
    } catch {
      setError("Spostamento non riuscito");
    } finally {
      setBusy(false);
    }
  }

  async function removePrevious() {
    const res = await fetch(`/api/projects/${projectId}/repo-path`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? "Eliminazione non riuscita");
      return;
    }
    toast.success(`Eliminata ${data.removed}`);
    onChanged();
  }

  return (
    <Section
      title="Dove stanno i file"
      summary={repoPath ? "Cartella scelta da te" : "Cartella dati del pannello"}
    >
      <div className="text-sm">
        <p className="font-mono break-all">{location.real ?? location.declared}</p>
        {location.real && location.real !== location.declared && (
          <FieldHint>
            Il pannello continua a raggiungerla da <Code>{location.declared}</Code>, che adesso è un
            collegamento: è così che tutto il resto la trova senza sapere che si è spostata.
          </FieldHint>
        )}
        {!location.real && (
          <FieldHint>Non c&apos;è ancora niente su disco: serve un deploy.</FieldHint>
        )}
      </div>

      {inFlight ? (
        <Hint tone="warn" title="Spostamento in corso">
          Il progetto è fermo finché non finisce. La copia di partenza non viene toccata: se
          qualcosa va storto il pannello la rimette dov&apos;era.
        </Hint>
      ) : (
        <>
          {move?.phase === "failed" && (
            <Hint tone="warn" title="L'ultimo spostamento non è riuscito">
              {move.error}{" "}
              {move.rolledBack
                ? "Il progetto è tornato dov'era."
                : "Attenzione: neanche il ritorno indietro è riuscito — controlla la cartella."}
            </Hint>
          )}

          {move?.phase === "done" && move.leftBehind && (
            <Hint tone="warn" title="La copia precedente è ancora al suo posto">
              Sta in <Code>{move.leftBehind}</Code>. Controlla che il progetto funzioni, poi
              eliminala.
              {move.leftBehind.includes(".prima-dello-spostamento") ? (
                <div className="mt-2">
                  <Button variant="danger" size="sm" onPress={removePrevious}>
                    <Icon icon="solar:trash-bin-trash-linear" width={16} aria-hidden />
                    Elimina la copia precedente
                  </Button>
                </div>
              ) : (
                <>
                  {" "}
                  È una cartella tua, fuori dalla cartella dati del pannello: eliminala tu, quando
                  sei sicuro.
                </>
              )}
            </Hint>
          )}

          <Field label="Sposta i file in un'altra cartella" hint={NATIVE_PATH_RULE} error={error ?? undefined}>
            <TextField value={value} onChange={setValue} aria-label="Percorso dei file">
              <Input />
            </TextField>
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              isPending={busy}
              onPress={() => {
                const parsed = nativePathSchema.safeParse(value);
                if (!parsed.success) {
                  setError(parsed.error.issues[0]?.message ?? NATIVE_PATH_RULE);
                  return;
                }
                void post({ path: parsed.data });
              }}
            >
              <Icon icon="solar:ssd-square-linear" width={16} aria-hidden />
              Sposta i file
            </Button>
            {repoPath && (
              <Button variant="outline" size="sm" isPending={busy} onPress={() => void post({ path: null })}>
                <Icon icon="solar:rewind-back-linear" width={16} aria-hidden />
                Torna alla cartella predefinita
              </Button>
            )}
          </div>

          <FieldHint>
            Il processo si ferma, la cartella viene copiata per intero — <Code>node_modules</Code> e
            build compresi, così riparte senza ricostruire — e al vecchio posto resta un
            collegamento. La copia di partenza non viene cancellata: resta finché non lo dici tu.
          </FieldHint>
        </>
      )}
    </Section>
  );
}
