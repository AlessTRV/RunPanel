"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { StatusBadge } from "@/components/StatusBadge";

interface Deployment {
  id: string;
  trigger_type: string;
  commit_sha: string | null;
  commit_message: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
}

function formatDuration(startedAt: string, finishedAt: string): string {
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function DeploymentCard({ deployment: d }: { deployment: Deployment }) {
  const [buildLog, setBuildLog] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function loadBuildLog() {
    if (buildLog !== null) {
      setExpanded(!expanded);
      return;
    }
    setLogLoading(true);
    try {
      const res = await fetch(`/api/deployments/${d.id}`);
      if (res.ok) {
        const data = await res.json();
        setBuildLog(data.build_log || "(no log output)");
        setExpanded(true);
      }
    } catch { /* ignore */ }
    setLogLoading(false);
  }

  return (
    <Card>
      <CardContent className="py-4">
        {/* Row 1: Status + info + duration */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="pt-0.5">
              <StatusBadge status={d.status} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {d.commit_message || `${d.trigger_type} deploy`}
              </p>
              <p className="text-xs text-foreground-400 mt-0.5">
                {d.commit_sha ? `${d.commit_sha.slice(0, 7)} · ` : ""}
                {new Date(d.started_at).toLocaleString()}
                {d.finished_at && ` · ${formatDuration(d.started_at, d.finished_at)}`}
              </p>
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            onPress={loadBuildLog}
            className="shrink-0"
          >
            {logLoading ? (
              <Spinner />
            ) : (
              <Icon
                icon={expanded ? "solar:alt-arrow-up-bold" : "solar:document-text-bold-duotone"}
                width={16}
              />
            )}
          </Button>
        </div>

        {/* Row 2: Error message (full width) */}
        {d.error_message && (
          <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2">
            <p className="text-sm text-danger">{d.error_message}</p>
          </div>
        )}

        {/* Row 3: Build log (expandable) */}
        {expanded && buildLog && (
          <div className="mt-3 max-h-96 overflow-auto rounded-lg bg-content2 p-3">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground-400">
              {buildLog}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function DeploymentsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDeployments();
  }, [projectId]);

  function fetchDeployments() {
    fetch(`/api/projects/${projectId}/logs`)
      .then((r) => r.ok ? r.json() : [])
      .then(setDeployments)
      .finally(() => setLoading(false));
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Deployments</h1>
          <p className="text-sm text-foreground-400">Deployment history for this project</p>
        </div>
        <Button variant="ghost" size="sm" onPress={fetchDeployments}>
          <Icon icon="solar:refresh-bold-duotone" width={16} />
          Refresh
        </Button>
      </div>

      {deployments.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-divider py-20">
          <Icon icon="solar:history-bold-duotone" className="mb-4 text-foreground-300" width={48} />
          <p className="text-foreground-400">No deployments yet</p>
          <p className="text-sm text-foreground-500">Deploy your project to see history here</p>
        </div>
      ) : (
        <div className="space-y-3">
          {deployments.map((d) => (
            <DeploymentCard key={d.id} deployment={d} />
          ))}
        </div>
      )}
    </div>
  );
}
