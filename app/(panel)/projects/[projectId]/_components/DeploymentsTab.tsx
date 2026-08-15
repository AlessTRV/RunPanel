"use client";

import { memo, useState } from "react";
import { Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { StatusBadge } from "@/components/StatusBadge";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { formatDurationBetween } from "@/lib/format";
import { type Deployment } from "./types";

/**
 * What started this deploy, when the commit message cannot say.
 *
 * A deploy of an uploaded project has no commit, and the fallback used to
 * render the column value raw — "Deploy manual", an English word in an Italian
 * panel, and "Deploy poll" once polling existed.
 */
const TRIGGER_LABEL: Record<string, string> = {
  manual: "Deploy manuale",
  webhook: "Deploy da webhook",
  poll: "Deploy da controllo periodico",
};

const DeploymentCard = memo(function DeploymentCard({ deployment }: { deployment: Deployment }) {
  const [buildLog, setBuildLog] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function toggleLog() {
    if (buildLog !== null) {
      setExpanded((e) => !e);
      return;
    }
    setLoading(true);
    try {
      // Only the tail: a Docker build can produce thousands of lines and
      // nobody reads the middle of one in a panel.
      const res = await fetch(`/api/deployments/${deployment.id}?tail=500`);
      if (res.ok) {
        const data = await res.json();
        setBuildLog(data.build_log?.trim() || "(nessun log)");
        setExpanded(true);
      }
    } catch {
      setBuildLog("(impossibile leggere il log)");
      setExpanded(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Panel padding="compact">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <StatusBadge status={deployment.status} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-foreground truncate text-sm">
              {deployment.commit_message || TRIGGER_LABEL[deployment.trigger_type] || "Deploy"}
            </p>
            <p className="text-muted mt-0.5 text-xs">
              {deployment.commit_sha && (
                <span className="font-mono">{deployment.commit_sha.slice(0, 7)} · </span>
              )}
              {new Date(deployment.started_at).toLocaleString()}
              {deployment.finished_at &&
                ` · ${formatDurationBetween(deployment.started_at, deployment.finished_at)}`}
            </p>
          </div>
        </div>

        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          onPress={toggleLog}
          aria-expanded={expanded}
          aria-label={expanded ? "Nascondi il log" : "Mostra il log"}
        >
          {loading ? (
            <Spinner />
          ) : (
            <Icon icon={expanded ? "solar:alt-arrow-up-linear" : "solar:document-text-linear"} width={16} />
          )}
        </Button>
      </div>

      {/*
        This field can be a raw `docker build` stderr dump. Rendered as prose it
        read like the panel talking; under a label, in mono, it reads as what it
        is — the output of the thing that failed.
      */}
      {deployment.error_message && (
        <div className="bg-danger/10 mt-3 rounded-[var(--radius)] px-3 py-2">
          <p className="text-danger text-meta mb-1">Errore riportato dal build</p>
          <pre className="text-danger overflow-auto font-mono text-xs break-words whitespace-pre-wrap">
            {deployment.error_message}
          </pre>
        </div>
      )}

      {expanded && buildLog && (
        <pre className="border-border bg-background text-muted mt-3 max-h-96 overflow-auto rounded-[var(--radius)] border p-3 font-mono text-xs break-words whitespace-pre-wrap">
          {buildLog}
        </pre>
      )}
    </Panel>
  );
});

export const DeploymentsTab = memo(function DeploymentsTab({
  deployments,
  loading,
}: {
  deployments: Deployment[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <SkeletonBlock key={i} className="h-20" />
        ))}
      </div>
    );
  }

  if (deployments.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon="solar:history-linear"
          title="Nessun deploy"
          description="La cronologia comparirà qui dopo il primo deploy del progetto."
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      {deployments.map((d) => (
        <DeploymentCard key={d.id} deployment={d} />
      ))}
    </div>
  );
});
