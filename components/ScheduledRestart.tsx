"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Input, Label, TextField } from "@heroui/react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { Segmented } from "@/components/ui/Segmented";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { InfoTip } from "@/components/ui/Tooltip";
import { formatWhen } from "@/lib/format";

/**
 * A restart on a schedule, for a project or a service.
 *
 * One component for both, because the scheduler treats them the same way and
 * the operator should read the same words on both pages. The switch is the
 * state: off means the expression is empty on the row, on means the row has
 * one and the panel will fire it. The preview comes from the server's parser —
 * the same one the tick runs — so what the form accepts is what will happen.
 */

const PRESETS: { label: string; cron: string }[] = [
  { label: "Ogni notte alle 04:00", cron: "0 4 * * *" },
  { label: "Ogni domenica alle 04:00", cron: "0 4 * * 0" },
  { label: "Ogni 6 ore", cron: "0 */6 * * *" },
  { label: "Ogni ora", cron: "0 * * * *" },
];

interface Preview {
  description: string;
  /** The zone the server read the expression in: the panel's, from Impostazioni. */
  timezone: string;
  occurrences: string[];
}

/**
 * An instant on the panel's clock, not the browser's.
 *
 * The expression is read in the panel's zone, so "0 4 * * *" is 04:00 there.
 * Printed in the browser's zone the same run read "06:00" from Rome against a
 * UTC panel, right under a line saying "alle 04:00".
 */
function formatInZone(iso: string | null, zone: string | undefined): string {
  if (!iso) return "—";
  if (!zone) return formatWhen(iso);
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: zone,
    }).format(new Date(iso));
  } catch {
    return formatWhen(iso);
  }
}

export function ScheduledRestart({
  kind,
  id,
  cron,
  nextAt,
  lastAt,
  lastResult,
  onSaved,
}: {
  kind: "project" | "service";
  id: string;
  cron: string;
  nextAt: string | null;
  lastAt: string | null;
  lastResult: string | null;
  /** Called with the row the API returned, so the parent can refresh its copy. */
  onSaved: (row: Record<string, unknown>) => void;
}) {
  const [enabled, setEnabled] = useState(cron !== "");
  const [draft, setDraft] = useState(cron || PRESETS[0].cron);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [cronError, setCronError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!enabled || !draft) return;
    const timer = setTimeout(() => {
      fetch("/api/backups/cron-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron: draft, count: 3 }),
      })
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) {
            setPreview(null);
            setCronError(body.error ?? "Espressione non valida");
            return;
          }
          setCronError(null);
          setPreview(body);
        })
        .catch(() => setCronError("Impossibile verificare la pianificazione"));
    }, 350);
    return () => clearTimeout(timer);
  }, [draft, enabled]);

  async function save(expression: string) {
    setPending(true);
    try {
      const res = await fetch(`/api/${kind === "project" ? "projects" : "services"}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restartCron: expression }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Salvataggio non riuscito");
      onSaved(body);
      toast.success(expression ? "Riavvio programmato salvato" : "Riavvio programmato disattivato");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Salvataggio non riuscito");
      throw err;
    } finally {
      setPending(false);
    }
  }

  async function toggle(next: boolean) {
    setEnabled(next);
    if (!next && cron !== "") {
      // Switching off is the save: there is nothing else to decide.
      await save("").catch(() => setEnabled(true));
    }
  }

  const dirty = enabled && draft !== cron;

  return (
    <Panel className="space-y-4">
      <PanelHeader
        title="Riavvio programmato"
        description="Un riavvio a orari fissi, nel fuso orario del pannello"
        actions={
          <InfoTip title="Cosa fa e cosa non fa">
            All&apos;ora stabilita RunPanel riavvia {kind === "project" ? "l'app" : "il container"} se è
            in esecuzione. Se l&apos;hai fermato tu, lo lascia fermo. Se è caduto da solo, fa un solo
            tentativo di rimetterlo in piedi e poi lascia perdere fino al prossimo crash. Un deploy in
            corso non viene mai interrotto.
          </InfoTip>
        }
      />

      <SettingToggle
        label="Riavvia a orari fissi"
        description={
          cron
            ? `Attivo: ${cron}${nextAt ? ` · prossimo ${formatInZone(nextAt, preview?.timezone)}` : ""}`
            : "Spento: nessun riavvio automatico"
        }
        isSelected={enabled}
        isDisabled={pending}
        onChange={(next) => void toggle(next)}
      />

      {enabled && (
        <>
          <Segmented
            label="Con che frequenza"
            value={PRESETS.some((p) => p.cron === draft) ? draft : ""}
            onChange={(value) => {
              if (value) setDraft(value);
            }}
            options={PRESETS.map((preset) => ({ value: preset.cron, label: preset.label }))}
          />

          <TextField value={draft} onChange={setDraft}>
            <Label>Espressione cron</Label>
            <Input placeholder="0 4 * * *" />
          </TextField>
          <FieldHint>
            Cinque campi: minuto, ora, giorno del mese, mese, giorno della settimana. L&apos;ora è quella
            del fuso scelto in{" "}
            <Link href="/settings" className="text-accent hover:underline">
              Impostazioni › Pannello
            </Link>
            .
          </FieldHint>

          {cronError && (
            <Hint tone="warn">{cronError}</Hint>
          )}
          {preview && !cronError && (
            <Hint tone="info" title={preview.description}>
              Prossimi riavvii, ora di <Code>{preview.timezone}</Code>:{" "}
              {preview.occurrences.map((o) => formatInZone(o, preview.timezone)).join(" · ")}
            </Hint>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="primary"
              size="sm"
              isDisabled={!dirty || pending || Boolean(cronError)}
              onPress={() => void save(draft).catch(() => {})}
            >
              Salva pianificazione
            </Button>
          </div>
        </>
      )}

      {lastAt && (
        <p className="text-muted text-meta">
          Ultima occorrenza {formatInZone(lastAt, preview?.timezone)}: <Code>{lastResult ?? "—"}</Code>
        </p>
      )}
    </Panel>
  );
}
