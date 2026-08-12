"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { LinkButton } from "@/components/ui/LinkButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { DeleteButton } from "@/components/ui/DangerAction";
import { DestinationForm } from "./_components/DestinationForm";
import { Hint } from "@/components/ui/Hint";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { StatTile } from "@/components/ui/StatTile";
import { StatusBadge } from "@/components/StatusBadge";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { formatBytes, formatDuration, formatRelative, formatWhen } from "@/lib/format";
import { triggerLabel } from "./_components/format";
import {
  describeTarget,
  type DestinationView,
  type PolicyView,
  type RunsResponse,
  type TargetCatalog,
} from "./_components/types";

/**
 * The one preset that matters: everything, every night, keep a week.
 *
 * A backup feature nobody configures is a backup feature nobody has, and the
 * blank editor is where most people stop. This is the shape almost everyone
 * wants, one click away.
 */
const NIGHTLY_PRESET = {
  name: "Backup notturno",
  cron: "0 3 * * *",
  targets: [
    { kind: "all-services" as const },
    { kind: "panel" as const },
    { kind: "all-projects" as const, include: ["config" as const] },
  ],
  retentionCount: 7,
};

export default function BackupsPage() {
  const poll20000 = usePollInterval(20000);
  const poll5000 = usePollInterval(5000);
  const router = useRouter();

  const runs = useResource<RunsResponse>("/api/backups/runs?limit=25", { intervalMs: poll5000 });
  const policies = useResource<{ policies: PolicyView[] }>("/api/backups/policies", {
    intervalMs: poll20000,
  });
  const destinations = useResource<{ destinations: DestinationView[] }>(
    "/api/backups/destinations"
  );
  const catalog = useResource<TargetCatalog>("/api/backups/targets");

  const [busy, setBusy] = useState<string | null>(null);
  const [addingDestination, setAddingDestination] = useState(false);

  const overview = runs.data?.overview;
  const activeRunId = runs.data?.activeRunId ?? null;

  async function post(url: string, label: string) {
    setBusy(url);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? `${label} non riuscita`);
        return null;
      }
      return body;
    } catch {
      toast.error(`${label} non riuscita`);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function runNow(policy: PolicyView) {
    const body = await post(`/api/backups/policies/${policy.id}/run`, "Esecuzione");
    if (!body?.runId) return;
    toast.success(`Backup avviato per "${policy.name}"`);
    router.push(`/backups/runs/${body.runId}`);
  }

  async function createPreset() {
    const destinationId = destinations.data?.destinations[0]?.id;
    if (!destinationId) {
      toast.error("Nessuna destinazione configurata");
      return;
    }

    setBusy("preset");
    try {
      const res = await fetch("/api/backups/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...NIGHTLY_PRESET, destinationId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Creazione non riuscita");
        return;
      }
      toast.success("Pianificazione creata: ogni giorno alle 03:00");
      policies.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function togglePolicy(policy: PolicyView) {
    setBusy(policy.id);
    try {
      const res = await fetch(`/api/backups/policies/${policy.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !policy.enabled }),
      });
      if (!res.ok) {
        toast.error("Modifica non riuscita");
        return;
      }
      policies.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function removePolicy(policyId: string) {
    const res = await fetch(`/api/backups/policies/${policyId}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Eliminazione non riuscita");
      return;
    }
    toast.success("Pianificazione eliminata. I backup già fatti restano.");
    policies.refresh();
  }

  async function removeRun(runId: string) {
    const res = await fetch(`/api/backups/runs/${runId}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "Eliminazione non riuscita");
      return;
    }
    toast.success("Backup eliminato, archivio compreso");
    runs.refresh();
  }

  async function testDestination(destination: DestinationView) {
    const body = await post(`/api/backups/destinations/${destination.id}`, "Verifica");
    if (!body) return;
    if (body.ok) toast.success(body.message);
    else toast.error(body.message);
  }

  if (runs.loading && !runs.data) {
    return (
      <>
        <PageHeader title="Backup" description="Copie dei database, della configurazione e dei dati." />
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <SkeletonBlock key={i} className="h-24" />
          ))}
        </div>
        <div className="space-y-4">
          <SkeletonBlock className="h-48" />
          <SkeletonBlock className="h-64" />
        </div>
      </>
    );
  }

  const policyList = policies.data?.policies ?? [];
  const runList = runs.data?.runs ?? [];

  return (
    <>
      <PageHeader
        title="Backup"
        description="Copie dei database gestiti, dello store del pannello e della configurazione dei progetti."
        actions={
          <LinkButton href="/backups/new">
            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
            Nuova pianificazione
          </LinkButton>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Ultimo backup"
          icon="solar:clock-circle-linear"
          value={formatRelative(overview?.lastRun?.startedAt ?? null)}
          hint={overview?.lastRun ? triggerLabel(overview.lastRun.trigger) : undefined}
        />
        <StatTile
          label="Spazio occupato"
          icon="solar:ssd-square-linear"
          value={formatBytes(overview?.totalBytes ?? 0)}
          hint={`${overview?.runCount ?? 0} archivi`}
        />
        <StatTile
          label="Ultimi 7 giorni"
          icon="solar:check-circle-linear"
          value={`${overview?.recent.ok ?? 0} ok`}
          hint={overview?.recent.failed ? `${overview.recent.failed} falliti` : "nessun fallimento"}
        />
        <StatTile
          label="Prossima esecuzione"
          icon="solar:calendar-linear"
          value={formatRelative(overview?.nextRunAt ?? null)}
          hint={overview?.nextRunAt ? formatWhen(overview.nextRunAt) : "nessuna pianificazione"}
        />
      </div>

      {activeRunId && (
        <Hint tone="info" className="mb-4">
          Un backup è in corso.{" "}
          <Link href={`/backups/runs/${activeRunId}`} className="text-accent underline">
            Segui l&apos;esecuzione
          </Link>
          .
        </Hint>
      )}

      <div className="space-y-4">
        <Panel padding="flush">
          <div className="p-4 sm:p-5">
            <PanelHeader
              title="Pianificazioni"
              description="Cosa viene salvato e quando. Una pianificazione senza orario si esegue solo su richiesta."
            />
          </div>

          {policyList.length === 0 ? (
            <EmptyState
              icon="solar:calendar-linear"
              title="Nessun backup pianificato"
              description="Comincia dalla configurazione che va bene quasi sempre: tutto quello che esiste, ogni notte alle 03:00, conservando l'ultima settimana."
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button size="sm" onPress={createPreset} isPending={busy === "preset"}>
                    <Icon icon="solar:magic-stick-3-linear" width={16} aria-hidden />
                    Crea il backup notturno
                  </Button>
                  <LinkButton href="/backups/new">Configura a mano</LinkButton>
                </div>
              }
            />
          ) : (
            <ul className="divide-border divide-y">
              {policyList.map((policy) => (
                <li key={policy.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/backups/policies/${policy.id}`}
                        className="text-foreground truncate text-sm font-medium hover:underline"
                      >
                        {policy.name}
                      </Link>
                      {!policy.enabled && (
                        <span className="text-muted bg-default rounded-full px-2 py-0.5 text-meta">
                          disattivata
                        </span>
                      )}
                      {policy.lastStatus && <StatusBadge status={policy.lastStatus} />}
                    </div>
                    <p className="text-muted mt-0.5 truncate text-xs">
                      {policy.schedule}
                      {policy.timezone ? ` · ${policy.timezone}` : ""} ·{" "}
                      {policy.targets.map((t) => describeTarget(t, catalog.data)).join(" · ")}
                    </p>
                  </div>

                  <div className="text-muted hidden text-right text-xs sm:block">
                    <div>prossima {formatRelative(policy.nextRunAt)}</div>
                    <div>ultima {formatRelative(policy.lastRunAt)}</div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => runNow(policy)}
                      isPending={busy === `/api/backups/policies/${policy.id}/run`}
                      isDisabled={Boolean(activeRunId)}
                    >
                      <Icon icon="solar:play-linear" width={15} aria-hidden />
                      Esegui ora
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => togglePolicy(policy)}
                      isPending={busy === policy.id}
                      aria-label={policy.enabled ? "Disattiva" : "Attiva"}
                    >
                      <Icon
                        icon={policy.enabled ? "solar:pause-linear" : "solar:play-circle-linear"}
                        width={16}
                        aria-hidden
                      />
                    </Button>
                    <DeleteButton
                      label={`Elimina la pianificazione ${policy.name}`}
                      confirm={{
                        title: `Eliminare "${policy.name}"?`,
                        description:
                          "Gli archivi già creati restano e si possono ancora ripristinare. Da adesso non ne verranno creati altri da questa pianificazione.",
                      }}
                      onConfirm={() => removePolicy(policy.id)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel padding="flush">
          <div className="p-4 sm:p-5">
            <PanelHeader
              title="Cronologia"
              description="Ogni esecuzione, con quello che è riuscito a salvare."
            />
          </div>

          {runList.length === 0 ? (
            <EmptyState
              icon="solar:archive-linear"
              title="Nessun backup eseguito"
              description="Appena una pianificazione parte, o premi Esegui ora, l'archivio compare qui."
            />
          ) : (
            <ul className="divide-border divide-y">
              {runList.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={run.status} />
                      <Link
                        href={`/backups/runs/${run.id}`}
                        className="text-foreground truncate text-sm hover:underline"
                      >
                        {run.policyName ?? "Esecuzione manuale"}
                      </Link>
                      {run.pinned && (
                        <span
                          className="text-muted"
                          title="Esente dalla retention: è il backup di sicurezza di un ripristino"
                        >
                          <Icon icon="solar:pin-linear" width={14} aria-hidden />
                        </span>
                      )}
                    </div>
                    <p className="text-muted mt-0.5 truncate text-xs">
                      {formatWhen(run.startedAt)} · {triggerLabel(run.trigger)} ·{" "}
                      {formatDuration(run.durationMs)}
                      {run.archiveBytes ? ` · ${formatBytes(run.archiveBytes)}` : ""}
                      {run.errorMessage ? ` · ${run.errorMessage}` : ""}
                    </p>
                  </div>

                  <div className="flex items-center gap-1">
                    {run.hasArchive && (
                      <LinkButton
                        href={`/api/backups/runs/${run.id}/download`}
                        variant="ghost"
                        download
                        aria-label="Scarica l'archivio"
                      >
                        <Icon icon="solar:download-linear" width={16} aria-hidden />
                      </LinkButton>
                    )}
                    <LinkButton href={`/backups/runs/${run.id}`}>Dettagli</LinkButton>
                    <DeleteButton
                      label="Elimina questo backup"
                      isDisabled={run.status === "running"}
                      confirm={{
                        title: "Eliminare questo backup?",
                        description:
                          "L'archivio viene cancellato dal disco. Se è l'ultimo riuscito, resti senza un punto di ripristino.",
                      }}
                      onConfirm={() => removeRun(run.id)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel padding="flush">
          <div className="p-4 sm:p-5">
            <PanelHeader
              title="Destinazioni"
              description="Dove finiscono gli archivi"
              actions={
                <Button size="sm" variant="secondary" onPress={() => setAddingDestination(true)}>
                  <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
                  Aggiungi
                </Button>
              }
            />
          </div>
          <ul className="divide-border divide-y">
            {(destinations.data?.destinations ?? []).map((destination) => (
              <li
                key={destination.id}
                className="flex items-center gap-3 px-4 py-3 sm:px-5"
              >
                <Icon icon="solar:folder-linear" width={16} className="text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-foreground truncate text-sm">{destination.name}</p>
                  <p className="text-muted text-xs">{destination.type}</p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => testDestination(destination)}
                  isPending={busy === `/api/backups/destinations/${destination.id}`}
                >
                  Verifica
                </Button>
              </li>
            ))}
          </ul>
        </Panel>

        <DestinationForm
          isOpen={addingDestination}
          onOpenChange={setAddingDestination}
          onCreated={destinations.refresh}
        />

        <Hint tone="warn" title="Gli archivi contengono segreti">
          Le variabili d&apos;ambiente e le credenziali dei servizi vengono salvate cifrate con la
          chiave di questo pannello, e i file stanno in <code>data/backups</code> con permessi 0600.
          Un archivio portato altrove resta illeggibile senza quella chiave, a meno che tu non abbia
          scelto di includerla.
        </Hint>
      </div>

    </>
  );
}
