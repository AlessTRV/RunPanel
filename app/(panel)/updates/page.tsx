"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { Hint, FieldHint } from "@/components/ui/Hint";
import { Segmented } from "@/components/ui/Segmented";
import { CommandBlock } from "@/components/ui/CommandBlock";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { useResource } from "@/lib/hooks/useResource";
import { formatRelative, formatWhen } from "@/lib/format";
import { MSG } from "@/lib/copy";
import {
  DEFAULT_PANEL_UPDATE_INTERVAL,
  isPanelUpdateInterval,
  PANEL_UPDATE_INTERVALS,
  type PanelUpdateInterval,
} from "@/lib/polling";
import { hasUpdate, isUpdateActive, type UpdateStatus } from "@/lib/panel-update";
import { Changelog } from "./_components/Changelog";
import { UpdateLog } from "./_components/UpdateLog";
import { SignatureSettings } from "./_components/SignatureSettings";

/**
 * Updating the panel, from the panel.
 *
 * The screen has one behaviour no other screen in RunPanel has: partway through
 * the operation it is watching, the server stops answering — on purpose. That
 * is what a restart is. So "the request failed" is a *state* here rather than
 * an error, and the page has to say "riavvio in corso" and keep knocking until
 * somebody opens the door.
 *
 * And when the door opens, it reloads rather than carries on. The panel that
 * came back was built from different sources, so its BUILD_ID is different and
 * every chunk this tab has not fetched yet is gone. Carrying on would mean a
 * chunk-loading error on the next navigation, which reads as a bug in the panel
 * rather than as the consequence of the update the operator just asked for.
 */

const INTERVAL_LABELS: Record<PanelUpdateInterval, string> = {
  "3600": "1 ora",
  "21600": "6 ore",
  "86400": "24 ore",
};

const INTERVAL_OPTIONS = PANEL_UPDATE_INTERVALS.map((value) => ({
  value,
  label: INTERVAL_LABELS[value],
}));

export default function UpdatesPage() {
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [savingInterval, setSavingInterval] = useState(false);
  /** Set only by the picker; the server's value is what shows until then. */
  const [chosenInterval, setChosenInterval] = useState<PanelUpdateInterval | null>(null);

  // Two cadences: quick while something is happening, unhurried otherwise. The
  // quick one is also what notices the panel coming back after the restart.
  const [justStarted, setJustStarted] = useState(false);
  const { data, error, refresh } = useResource<UpdateStatus>("/api/updates", {
    intervalMs: 30_000,
  });

  const active = isUpdateActive(data) || justStarted;
  const awaitingRestart = data?.run?.phase === "awaiting-restart";

  /*
    The reload, fired once.

    The ref latches while the panel is on its way down, so the reload only
    happens in a tab that actually watched the update — one opened afterwards
    would otherwise reload itself on arrival. Written and read in effects only:
    a ref read during render is a ref that can be stale.
  */
  const sawRestart = useRef(false);
  useEffect(() => {
    if (awaitingRestart) sawRestart.current = true;
  }, [awaitingRestart]);

  useEffect(() => {
    if (!sawRestart.current) return;
    if (data?.run?.phase !== "done") return;
    // The panel answered again and the run is settled, so this tab is now
    // talking to a build it was not served by: its chunks are gone.
    window.location.reload();
  }, [data?.run?.phase]);

  /*
    A second, faster poll while something is in flight.

    Separate from `useResource` rather than a variable interval on it: the
    interval is in that hook's effect dependencies, so changing it tears the
    subscription down and rebuilds it — in the middle of the one operation
    during which the connection is already unreliable.
  */
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(refresh, 2_000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  async function checkNow() {
    setChecking(true);
    try {
      const res = await fetch("/api/updates/check", { method: "POST" });
      if (!res.ok) {
        toast.error(MSG.loadFailed);
        return;
      }
      const body = (await res.json()) as { error: string | null; behind: number };
      if (body.error) toast.error(body.error);
      else if (body.behind > 0) toast.success(`${body.behind} commit da applicare`);
      else toast.success("Il pannello è aggiornato");
      refresh();
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setChecking(false);
    }
  }

  async function startUpdate() {
    setStarting(true);
    try {
      const res = await fetch("/api/updates/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedSha: data?.check?.remoteSha ?? null }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? MSG.updateFailed);
        return;
      }
      setJustStarted(true);
      refresh();
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setStarting(false);
    }
  }

  async function saveInterval(next: PanelUpdateInterval) {
    setChosenInterval(next);
    setSavingInterval(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences: { panel_update_interval: next } }),
      });
      if (res.ok) toast.success("Frequenza salvata");
      else toast.error(MSG.saveFailed);
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setSavingInterval(false);
    }
  }

  if (!data) return <PageSkeleton />;

  const { check, checkout, run, canUpdate, blocker } = data;
  const available = hasUpdate(data);
  const interval =
    chosenInterval ??
    (isPanelUpdateInterval(data.interval) ? data.interval : DEFAULT_PANEL_UPDATE_INTERVAL);

  /*
    A failed request while the panel is on its way down is the expected course
    of events, not something to report. Derived from the last state the panel
    managed to publish — `awaiting-restart` — rather than from a flag, so the
    page reads the same whether this tab pressed the button or merely had the
    page open.
  */
  const offline = Boolean(error) && awaitingRestart;

  return (
    <>
      <PageHeader
        title="Aggiornamenti"
        description="La versione di RunPanel installata su questa macchina"
        actions={
          <Button variant="ghost" size="sm" isPending={checking} onPress={checkNow}>
            <Icon icon="solar:refresh-circle-linear" width={16} aria-hidden />
            Controlla ora
          </Button>
        }
      />

      <div className="max-w-3xl space-y-4">
        {offline && <Restarting />}

        <Panel className="space-y-4">
          <PanelHeader
            title={`RunPanel ${data.release.label}`}
            description={
              checkout.isRepo
                ? `Branch ${checkout.branch ?? "—"} · ${checkout.remote ?? "nessun remote"}`
                : "Questa installazione non è un checkout git"
            }
          />

          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Fact
              label="Build in esecuzione"
              value={
                data.release.number !== null
                  ? `${data.release.number} · ${data.release.short ?? "—"}`
                  : (data.release.short ?? "—")
              }
              mono
              title={
                data.release.shallow
                  ? "Il checkout è shallow, quindi il numero di build non è calcolabile"
                  : (data.release.date ?? undefined)
              }
            />
            <Fact
              label="Ultimo controllo"
              value={check ? formatRelative(check.checkedAt) : "mai"}
              title={check ? formatWhen(check.checkedAt) : undefined}
            />
            <Fact
              label="Disponibile"
              value={
                check?.remoteSha
                  ? check.behind > 0
                    ? `${check.remoteSha.slice(0, 7)} (+${check.behind})`
                    : "nessun aggiornamento"
                  : "—"
              }
              mono={Boolean(check?.behind)}
            />
          </dl>

          {check?.error && (
            <Hint tone="warn" title="L'ultimo controllo non ha potuto rispondere">
              {check.error}
            </Hint>
          )}

          {!canUpdate.ok && canUpdate.reason && (
            <Hint tone="warn" title="Questo host non si aggiorna da solo">
              {canUpdate.reason}
            </Hint>
          )}

          {canUpdate.ok && canUpdate.restart === "manual" && (
            <Hint tone="warn" title="Il riavvio sarà manuale">
              {canUpdate.reason}
            </Hint>
          )}

          {blocker && <Hint tone="warn">{blocker.reason}</Hint>}

          {available && (
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                isPending={starting}
                isDisabled={active || Boolean(blocker) || (!canUpdate.ok && canUpdate.restart !== "manual")}
                onPress={startUpdate}
              >
                {canUpdate.restart === "manual" ? "Prepara l'aggiornamento" : "Aggiorna e riavvia"}
              </Button>
              <span className="text-muted text-xs">
                {canUpdate.restart === "manual"
                  ? "Scarica, installa e builda; lo scambio lo fai tu."
                  : "Il pannello si riavvia da solo. I progetti e i servizi restano su."}
              </span>
            </div>
          )}
        </Panel>

        {available && check && (
          <Panel className="space-y-3">
            <PanelHeader
              title={check.behind === 1 ? "Un commit da applicare" : `${check.behind} commit da applicare`}
              description="Dal più recente"
            />
            <Changelog commits={check.commits} total={check.behind} />
          </Panel>
        )}

        {run && (
          <Panel className="space-y-3">
            <PanelHeader
              title={runTitle(run.phase)}
              description={
                run.step ? `${run.step} · avviato ${formatRelative(run.startedAt)}` : undefined
              }
            />

            {run.error && <Hint tone="warn">{run.error}</Hint>}

            {run.phase === "awaiting-manual" && run.manualCommands.length > 0 && (
              <>
                <Hint tone="warn" title="Costruito, non ancora attivo">
                  La nuova versione è pronta in <code>.next-update</code>. Non è stata messa al
                  posto di quella in uso perché su questo host niente riavvierebbe il pannello
                  dopo l&apos;uscita, e una build scambiata sotto un processo che continua a
                  girare non funziona.
                </Hint>
                <CommandBlock commands={run.manualCommands} />
              </>
            )}

            {run.phase === "done" && run.storeBackup && (
              <FieldHint>
                Copia dello store presa prima dell&apos;aggiornamento:{" "}
                <code>{run.storeBackup}</code>
              </FieldHint>
            )}

            <UpdateLog run={run} live={active} />
          </Panel>
        )}

        <Section title="Controllo periodico" summary="Ogni quanto il pannello guarda il suo repository">
          <Segmented
            label="Frequenza del controllo aggiornamenti"
            value={interval}
            onChange={saveInterval}
            options={INTERVAL_OPTIONS}
            className={savingInterval ? "opacity-60" : undefined}
          />
          <FieldHint>
            Il controllo è un <code>git fetch</code> sul repository da cui il pannello è
            installato, esattamente come per i progetti: solo traffico in uscita, nessuna
            richiesta verso questa macchina. E non applica mai niente da solo — aggiornare resta
            una cosa che decidi tu, perché comporta un riavvio.
          </FieldHint>
        </Section>

        <Section
          title="Verifica della sorgente"
          summary="Da dove il pannello accetta di aggiornarsi, e a quali condizioni"
        >
          <SignatureSettings />
        </Section>
      </div>
    </>
  );
}

function runTitle(phase: string): string {
  if (phase === "running") return "Aggiornamento in corso";
  if (phase === "awaiting-restart") return "Riavvio in corso";
  if (phase === "awaiting-manual") return "In attesa di un riavvio manuale";
  if (phase === "failed") return "Ultimo aggiornamento non riuscito";
  return "Ultimo aggiornamento";
}

function Fact({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted text-meta tracking-wider uppercase">{label}</dt>
      <dd
        className={`text-foreground mt-0.5 truncate ${mono ? "font-mono text-sm" : "text-sm"}`}
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}

/** The one screen state that is a successful outcome of a failed request. */
function Restarting() {
  return (
    <Hint tone="info" icon="solar:refresh-circle-linear" title="Il pannello si sta riavviando">
      È previsto: il processo esce e il supervisore lo rimette su. Questa pagina si ricarica da
      sola appena risponde di nuovo — di solito entro una decina di secondi.
    </Hint>
  );
}
