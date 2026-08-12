"use client";

import { use, useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { LinkButton } from "@/components/ui/LinkButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Hint } from "@/components/ui/Hint";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";
import { useEventStream } from "@/lib/hooks/useEventStream";
import { useResource } from "@/lib/hooks/useResource";
import { formatBytes } from "@/lib/utils";
import { RestoreDialog } from "../../_components/RestoreDialog";
import { formatDuration, formatWhen, triggerLabel } from "../../_components/format";
import type { ArtifactView, RunDetail } from "../../_components/types";

type OpsEvent =
  | { type: "ready"; runId: string; status: string }
  | { type: "backup:log"; line: string }
  | { type: "backup:status"; status: string; message?: string }
  | { type: "backup:artifact"; label: string; status: string; bytes?: number; error?: string };

const KIND_LABELS: Record<string, string> = {
  "service-db": "Database",
  "panel-store": "Store del pannello",
  "project-config": "Configurazione",
  "project-volume": "Volume",
  "project-repo": "Repository",
};

export default function BackupRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);

  const { data, loading, error, refresh } = useResource<RunDetail>(
    `/api/backups/runs/${runId}`,
    { intervalMs: 4000 }
  );

  const [restoreOpen, setRestoreOpen] = useState(false);
  const running = data?.status === "running";
  const [streamed, setStreamed] = useState<LogLine[]>([]);
  // Touched only from the event handler, never during render: the id has to be
  // stable per line, because LogViewer keys rows on it and the buffer is
  // trimmed from the front.
  const nextId = useRef(0);

  const onEvent = useCallback(
    (event: OpsEvent) => {
      if (event.type === "backup:log") {
        const line = { id: nextId.current++, text: event.line };
        setStreamed((current) => [...current.slice(-2000), line]);
      }
      if (event.type === "backup:status" && event.status !== "running") {
        // The poll would notice within a few seconds anyway; asking now means
        // the page stops saying "in corso" the moment it stops being true.
        refresh();
      }
    },
    [refresh]
  );

  // Opened only while the run is live. A finished run's stream closes itself,
  // and EventSource would reconnect to it forever, replaying the whole log on
  // every retry.
  useEventStream<OpsEvent>(running ? `/api/backups/runs/${runId}/stream` : null, onEvent);

  // `data.log` is the authority once the run is over; while it runs the stream
  // is, because the file is still being written. The finished log arrives whole
  // and never shifts, so its index is a stable key; the streamed one is trimmed
  // from the front, so its lines carry an id assigned when they arrived.
  const lines = useMemo<LogLine[]>(() => {
    if (running) return streamed;
    return (data?.log ?? "")
      .split("\n")
      .filter(Boolean)
      .map((text, index) => ({ id: index, text }));
  }, [running, streamed, data?.log]);

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Backup" />
        <div className="space-y-4">
          <SkeletonBlock className="h-28" />
          <SkeletonBlock className="h-48" />
          <SkeletonBlock className="h-64" />
        </div>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <PageHeader title="Backup" />
        <Panel>
          <EmptyState
            icon="solar:danger-triangle-linear"
            title="Backup non trovato"
            description="Potrebbe essere stato eliminato, insieme al suo archivio."
            action={
              <LinkButton href="/backups">Torna ai backup</LinkButton>
            }
          />
        </Panel>
      </>
    );
  }

  const ok = data.artifacts.filter((artifact) => artifact.status === "ok");
  const failed = data.artifacts.filter((artifact) => artifact.status === "failed");
  const skipped = data.artifacts.filter((artifact) => artifact.status === "skipped");

  return (
    <>
      <PageHeader
        title={data.policyName ?? "Esecuzione manuale"}
        description={`${formatWhen(data.startedAt)} · ${triggerLabel(data.trigger)}`}
        actions={
          <div className="flex items-center gap-2">
            {data.hasArchive && ok.length > 0 && (
              <Button variant="secondary" size="sm" onPress={() => setRestoreOpen(true)}>
                <Icon icon="solar:restart-linear" width={16} aria-hidden />
                Ripristina
              </Button>
            )}
            {data.hasArchive && (
              <LinkButton href={`/api/backups/runs/${data.id}/download`} download>
                <Icon icon="solar:download-linear" width={16} aria-hidden />
                Scarica
              </LinkButton>
            )}
            <LinkButton href="/backups" variant="ghost">
              Tutti i backup
            </LinkButton>
          </div>
        }
      />

      <div className="space-y-4">
        <Panel>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <StatusBadge status={data.status} />
              {data.pinned && (
                <span className="text-muted flex items-center gap-1 text-xs">
                  <Icon icon="solar:pin-linear" width={13} aria-hidden />
                  esente dalla retention
                </span>
              )}
            </div>
            <Field label="Durata" value={formatDuration(data.durationMs)} />
            <Field
              label="Archivio"
              value={data.archiveBytes ? formatBytes(data.archiveBytes) : "—"}
            />
            <Field label="Elementi" value={`${ok.length} ok, ${failed.length} falliti, ${skipped.length} saltati`} />
            {data.checksum && (
              <Field label="sha256" value={<code className="text-[11px]">{data.checksum.slice(0, 16)}…</code>} />
            )}
          </div>

          {data.status === "partial" && (
            <Hint tone="warn" className="mt-4">
              Alcuni elementi non sono stati salvati. L&apos;archivio contiene comunque tutto il
              resto: un backup parziale è molto più utile di nessun backup, ma vale la pena capire
              cosa è mancato.
            </Hint>
          )}

          {data.status === "failed" && data.errorMessage && (
            <Hint tone="warn" className="mt-4" title="Il backup è fallito">
              {data.errorMessage}
            </Hint>
          )}
        </Panel>

        <Panel padding="flush">
          <div className="p-4 sm:p-5">
            <PanelHeader
              title="Contenuto"
              description="Un elemento per ogni cosa che il backup ha provato a salvare."
            />
          </div>

          {data.artifacts.length === 0 ? (
            <EmptyState
              icon="solar:box-linear"
              title="Nessun elemento"
              description="Il backup si è fermato prima di riuscire a salvare qualcosa."
            />
          ) : (
            <ul className="divide-border divide-y">
              {data.artifacts.map((artifact) => (
                <ArtifactRow key={artifact.id} artifact={artifact} />
              ))}
            </ul>
          )}
        </Panel>

        <Panel padding="flush">
          <div className="p-4 sm:p-5">
            <PanelHeader
              title="Log"
              description={running ? "In diretta." : "Registrato durante l'esecuzione."}
            />
          </div>
          <div className="px-4 pb-4 sm:px-5 sm:pb-5">
            <LogViewer
              lines={lines}
              ariaLabel="Log del backup"
              emptyMessage="Nessun output registrato."
              className="h-80"
            />
          </div>
        </Panel>
      </div>

      <RestoreDialog
        runId={data.id}
        artifacts={data.artifacts}
        isOpen={restoreOpen}
        onOpenChange={setRestoreOpen}
      />
    </>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-muted text-xs">{label}</p>
      <p className="text-foreground mt-0.5 text-sm">{value}</p>
    </div>
  );
}

function ArtifactRow({ artifact }: { artifact: ArtifactView }) {
  const meta = artifact.meta ?? {};
  const tool = typeof meta.tool === "string" ? meta.tool : null;
  const toolVersion = typeof meta.toolVersion === "string" ? meta.toolVersion : null;

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusBadge status={artifact.status === "ok" ? "success" : artifact.status} />
          <span className="text-foreground truncate text-sm">{artifact.refName}</span>
          <span className="text-muted text-xs">{KIND_LABELS[artifact.kind] ?? artifact.kind}</span>
        </div>
        <p className="text-muted mt-0.5 truncate text-xs">
          {artifact.entryPath || "—"}
          {tool ? ` · ${toolVersion ?? tool}` : ""}
          {artifact.errorMessage ? ` · ${artifact.errorMessage}` : ""}
        </p>
      </div>
      <span className="text-muted shrink-0 text-xs tabular-nums">
        {artifact.bytes > 0 ? formatBytes(artifact.bytes) : "—"}
      </span>
    </li>
  );
}
