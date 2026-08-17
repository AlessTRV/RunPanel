"use client";

import { useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Field } from "@/components/ui/Field";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { CommandBlock } from "@/components/ui/CommandBlock";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";
import { DATA_PATH_RULE, dataPathSchema } from "@/lib/validation";
import type { DataMove, MovePhase } from "@/lib/hooks/useServiceStream";
import type { Service } from "./types";

/**
 * Where this service keeps its data, and moving it somewhere else.
 *
 * A sibling of the databases panel rather than a section inside it: Redis has
 * no named databases and gets a different panel there entirely, but it has a
 * data directory like everything else.
 */

const PHASE_LABEL: Record<MovePhase, string> = {
  checking: "Controllo la destinazione…",
  stopping: "Fermo il servizio…",
  copying: "Copio i dati…",
  recreating: "Ricreo il container…",
  starting: "Aspetto che il motore risponda…",
  "rolling-back": "Torno alla posizione precedente…",
  done: "Spostamento completato",
  failed: "Spostamento non riuscito",
};

const RUNNING: MovePhase[] = ["checking", "stopping", "copying", "recreating", "starting", "rolling-back"];

export function DataPathPanel({
  service,
  move,
  lines,
  progress,
  onChanged,
}: {
  service: Service;
  move: DataMove | null;
  lines: LogLine[];
  progress: { copiedKb: number; totalKb: number | null } | null;
  onChanged: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adopt, setAdopt] = useState(false);
  const [found, setFound] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const inFlight = move !== null && RUNNING.includes(move.phase);
  const custom = Boolean(service.dataPath);
  const where = service.dataPath ?? service.dataDefault?.source ?? "—";

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/services/${service.id}/data-path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === "destination-not-empty") {
        // The checkbox only exists once there is something to adopt: offered up
        // front it would read as a shortcut rather than as a decision.
        setFound(data.entries ?? []);
        setError(data.error ?? null);
        return;
      }
      if (!res.ok) {
        setError(data.details?.[0]?.message ?? data.error ?? "Spostamento non riuscito");
        return;
      }
      setError(null);
      setFound(null);
      onChanged();
    } catch {
      setError("Spostamento non riuscito");
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const parsed = dataPathSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? DATA_PATH_RULE);
      return;
    }
    void post({ path: parsed.data, adoptExisting: adopt });
  }

  async function removePrevious() {
    const res = await fetch(`/api/services/${service.id}/data-path`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? "Eliminazione non riuscita");
      return;
    }
    if (data.command) {
      // A host directory is not the panel's to delete: a symlink, a mount point
      // or a typo has no upper bound on what `rm -rf` would take with it.
      setCommand(data.command);
      return;
    }
    toast.success(`Eliminato ${data.removed}`);
    onChanged();
  }

  return (
    <Panel className="space-y-4">
      <PanelHeader
        title="Dove stanno i dati"
        description={custom ? "Cartella scelta da te" : "Volume gestito da Docker"}
        actions={<Icon icon="solar:ssd-square-linear" width={18} className="text-muted" aria-hidden />}
      />

      <div className="text-sm">
        <p className="font-mono break-all">{where}</p>
        {service.dataDefault?.target && (
          <FieldHint>
            Montata su <Code>{service.dataDefault.target}</Code> dentro il container.
          </FieldHint>
        )}
      </div>

      {inFlight ? (
        <>
          <Hint tone="warn" title={PHASE_LABEL[move.phase]}>
            Il servizio è fermo finché lo spostamento non finisce. I dati di partenza non vengono
            toccati: se qualcosa va storto il pannello rimette il container dov&apos;era.
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
          <LogViewer lines={lines} ariaLabel="Log dello spostamento" className="h-[200px]" />
        </>
      ) : (
        <>
          {move?.phase === "failed" && (
            <Hint tone="warn" title="L'ultimo spostamento non è riuscito">
              {move.error}{" "}
              {move.rolledBack
                ? "Il servizio è tornato alla posizione precedente e i dati sono al loro posto."
                : "Attenzione: neanche il ritorno indietro è riuscito — controlla lo stato del container."}
            </Hint>
          )}

          {move?.phase === "done" && move.leftBehind && (
            <Hint tone="warn" title="I dati precedenti sono ancora al loro posto">
              Stanno in <Code>{move.leftBehind.ref}</Code>. Controlla che il servizio funzioni e che
              i dati ci siano davvero, poi eliminali — da lì non si torna indietro.
              <div className="mt-2">
                <Button variant="danger" size="sm" onPress={() => setAsking(true)}>
                  <Icon icon="solar:trash-bin-trash-linear" width={16} aria-hidden />
                  Elimina i dati precedenti
                </Button>
              </div>
            </Hint>
          )}

          <ConfirmDialog
            isOpen={asking}
            onOpenChange={setAsking}
            title="Eliminare i dati precedenti?"
            description={`${move?.leftBehind?.ref ?? ""} viene svuotata. Verifica prima che i dati nella posizione nuova ci siano davvero.`}
            confirmLabel="Elimina"
            destructive
            onConfirm={removePrevious}
          />

          {command && (
            <div>
              <FieldHint>
                Il pannello non cancella una cartella dell&apos;host: eseguila tu, dopo aver
                controllato che sia quella giusta.
              </FieldHint>
              <CommandBlock commands={[command]} />
            </div>
          )}

          <Field
            label="Sposta i dati in un'altra cartella"
            hint={DATA_PATH_RULE}
            error={error ?? undefined}
          >
            <TextField value={value} onChange={setValue} aria-label="Percorso dei dati">
              <Input placeholder="/mnt/dati/postgres" />
            </TextField>
          </Field>

          {found && (
            <Hint tone="warn" title="La cartella non è vuota">
              Contiene {found.slice(0, 5).join(", ")}
              {found.length > 5 ? "…" : ""}. Se sono i dati di questo servizio — un&apos;installazione
              precedente, un disco che stai riadottando — spunta la casella: il pannello monta la
              cartella com&apos;è, senza copiare niente sopra.
              <label className="mt-2 flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={adopt}
                  onChange={(e) => setAdopt(e.target.checked)}
                  className="accent-warning mt-0.5 size-4"
                />
                <span className="text-xs leading-relaxed">Usa i dati che ci sono già</span>
              </label>
            </Hint>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" isPending={busy} onPress={submit}>
              <Icon icon="solar:ssd-square-linear" width={16} aria-hidden />
              Sposta i dati
            </Button>
            {custom && (
              <Button
                variant="outline"
                size="sm"
                isPending={busy}
                onPress={() => void post({ path: null })}
              >
                <Icon icon="solar:rewind-back-linear" width={16} aria-hidden />
                Torna al volume predefinito
              </Button>
            )}
          </div>

          <FieldHint>
            Il servizio si ferma, i dati vengono copiati, il container riparte sulla cartella nuova e
            il pannello controlla che i database ci siano ancora. Se non ci sono, torna indietro da
            solo. I dati di partenza restano dove sono finché non li elimini tu.
          </FieldHint>
        </>
      )}
    </Panel>
  );
}
