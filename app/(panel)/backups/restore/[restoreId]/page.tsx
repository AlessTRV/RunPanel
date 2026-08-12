"use client";

import { use, useCallback, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { Hint } from "@/components/ui/Hint";
import { LinkButton } from "@/components/ui/LinkButton";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";
import { useEventStream } from "@/lib/hooks/useEventStream";
import { useResource } from "@/lib/hooks/useResource";
import { formatDuration, formatWhen } from "../../_components/format";

interface RestoreDetail {
  id: string;
  runId: string | null;
  source: string;
  status: string;
  safetyRunId: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  log: string;
}

type OpsEvent =
  | { type: "ready"; restoreId: string; status: string }
  | { type: "restore:log"; line: string }
  | { type: "restore:status"; status: string; message?: string };

export default function RestorePage({ params }: { params: Promise<{ restoreId: string }> }) {
  const { restoreId } = use(params);

  const { data, loading, error, refresh } = useResource<RestoreDetail>(
    `/api/backups/restore/${restoreId}`,
    { intervalMs: 3000 }
  );

  const running = data?.status === "running";
  const [streamed, setStreamed] = useState<LogLine[]>([]);
  const nextId = useRef(0);

  const onEvent = useCallback(
    (event: OpsEvent) => {
      if (event.type === "restore:log") {
        const line = { id: nextId.current++, text: event.line };
        setStreamed((current) => [...current.slice(-2000), line]);
      }
      if (event.type === "restore:status" && event.status !== "running") refresh();
    },
    [refresh]
  );

  useEventStream<OpsEvent>(running ? `/api/backups/restore/${restoreId}/stream` : null, onEvent);

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
        <PageHeader title="Ripristino" />
        <div className="space-y-4">
          <SkeletonBlock className="h-24" />
          <SkeletonBlock className="h-64" />
        </div>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <PageHeader title="Ripristino" />
        <Panel>
          <EmptyState
            icon="solar:danger-triangle-linear"
            title="Ripristino non trovato"
            action={<LinkButton href="/backups">Torna ai backup</LinkButton>}
          />
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Ripristino"
        description={`${formatWhen(data.startedAt)} · ${
          data.source === "upload" ? "da archivio caricato" : "da un backup in catalogo"
        }`}
        actions={
          <div className="flex items-center gap-2">
            {data.runId && (
              <LinkButton href={`/backups/runs/${data.runId}`} variant="ghost">
                Backup di origine
              </LinkButton>
            )}
            <LinkButton href="/backups">Tutti i backup</LinkButton>
          </div>
        }
      />

      <div className="space-y-4">
        <Panel>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <StatusBadge status={data.status} />
            <div>
              <p className="text-muted text-xs">Durata</p>
              <p className="text-foreground mt-0.5 text-sm">{formatDuration(data.durationMs)}</p>
            </div>
          </div>

          {data.safetyRunId && (
            <Hint tone="tip" className="mt-4" title="Rete di sicurezza">
              Prima di sovrascrivere è stato preso un backup di quello che c&apos;era.{" "}
              <a href={`/backups/runs/${data.safetyRunId}`} className="text-accent underline">
                È qui
              </a>{" "}
              e la retention non lo tocca.
            </Hint>
          )}

          {data.status === "failed" && data.errorMessage && (
            <Hint tone="warn" className="mt-4" title="Il ripristino è fallito">
              {data.errorMessage}
            </Hint>
          )}

          {data.status === "success" && (
            <Hint tone="info" className="mt-4">
              <Icon icon="solar:check-circle-linear" width={14} className="inline" aria-hidden />{" "}
              Fatto. Se hai ripristinato lo store del pannello, sarà attivo al prossimo riavvio.
            </Hint>
          )}
        </Panel>

        <Panel padding="flush">
          <div className="p-4 sm:p-5">
            <PanelHeader
              title="Log"
              description={running ? "In diretta." : "Registrato durante l'operazione."}
            />
          </div>
          <div className="px-4 pb-4 sm:px-5 sm:pb-5">
            <LogViewer
              lines={lines}
              ariaLabel="Log del ripristino"
              emptyMessage="Nessun output registrato."
              className="h-96"
            />
          </div>
        </Panel>
      </div>
    </>
  );
}
