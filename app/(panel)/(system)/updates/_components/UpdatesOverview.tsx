"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { LinkButton } from "@/components/ui/LinkButton";
import { LoadError } from "@/components/ui/LoadError";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SelectField } from "@/components/ui/SelectField";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { ServerFilter } from "@/components/cluster/ServerBits";
import { useResource } from "@/lib/hooks/useResource";
import { useMe } from "@/lib/hooks/useMe";
import { useMemberApi, useNode, useServerHref } from "@/lib/hooks/useNode";
import { formatRelative } from "@/lib/format";
import { MSG } from "@/lib/copy";
import { hasUpdate, isUpdateActive, type UpdateStatus } from "@/lib/panel-update";
import {
  DEFAULT_PANEL_UPDATE_INTERVAL,
  isPanelUpdateInterval,
  PANEL_UPDATE_INTERVAL_LABELS,
  PANEL_UPDATE_INTERVALS,
  type PanelUpdateInterval,
} from "@/lib/polling";
import type { PerServer } from "@/lib/cluster-merge";
import { cn } from "@/lib/utils";

/**
 * Updates of every server on one page, nodes included: a node has no panel of
 * its own to open, so everything about its updates is done from here.
 *
 * Per server: version, what is waiting, how often it checks by itself, and the
 * buttons. Every call goes to that server through the signed forwarding, so
 * the check, the build and the restart happen there. The commits, the live log
 * and the signature settings stay on each server's own page, one click away.
 */

type Server = PerServer<UpdateStatus>;

const INTERVAL_OPTIONS = PANEL_UPDATE_INTERVALS.map((value) => ({
  value,
  label: `Ogni ${PANEL_UPDATE_INTERVAL_LABELS[value]}`,
}));

function intervalOf(status: UpdateStatus): PanelUpdateInterval {
  return isPanelUpdateInterval(status.interval) ? status.interval : DEFAULT_PANEL_UPDATE_INTERVAL;
}

function canApply(status: UpdateStatus | null): boolean {
  if (!status || isUpdateActive(status) || !hasUpdate(status)) return false;
  const manual = status.canUpdate.restart === "manual";
  return !status.blocker && (status.canUpdate.ok || manual);
}

export function UpdatesOverview() {
  const { selfId } = useNode();
  const { isOwner } = useMe();
  const memberApi = useMemberApi();
  const href = useServerHref();
  const { data, error, loading, refresh } = useResource<{ servers: Server[] }>("/api/cluster/updates", {
    intervalMs: 15_000,
  });
  // null: nothing to confirm; "all": every server with an update; else one server.
  const [confirming, setConfirming] = useState<Server | "all" | null>(null);
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [intervals, setIntervals] = useState<Record<string, PanelUpdateInterval>>({});

  const servers = data?.servers ?? [];
  const updatable = servers.filter((s) => canApply(s.data));
  const checkable = servers.filter((s) => s.data);

  async function check(targets: Server[]) {
    setChecking(new Set(targets.map((s) => s.memberId)));
    try {
      const results = await Promise.allSettled(
        targets.map(async (s) => {
          const res = await fetch(memberApi(s.memberId, "/api/updates/check"), { method: "POST" });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? "Controllo non riuscito");
          }
        })
      );
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          toast.error(`${targets[i].memberName}: ${r.reason instanceof Error ? r.reason.message : MSG.unreachable}`);
        }
      });
      await refresh();
    } finally {
      setChecking(new Set());
    }
  }

  async function applyOne(server: Server): Promise<boolean> {
    try {
      const res = await fetch(memberApi(server.memberId, "/api/updates/apply"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedSha: server.data?.check?.remoteSha ?? null }),
      });
      if (res.ok) return true;
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(`${server.memberName}: ${body.error ?? MSG.updateFailed}`);
    } catch {
      toast.error(`${server.memberName}: ${MSG.unreachable}`);
    }
    return false;
  }

  async function apply(target: Server | "all") {
    // This panel goes last: once it restarts, this page stops hearing from the others.
    const targets =
      target === "all"
        ? [...updatable.filter((s) => s.memberId !== selfId), ...updatable.filter((s) => s.memberId === selfId)]
        : [target];
    const started: string[] = [];
    for (const server of targets) {
      if (await applyOne(server)) started.push(server.memberName);
    }
    if (started.length > 0) toast.success(`Aggiornamento avviato su ${started.join(", ")}`);
    await refresh();
    return started.length > 0 ? undefined : false;
  }

  async function saveInterval(server: Server, next: PanelUpdateInterval) {
    const previous = intervals[server.memberId];
    setIntervals((all) => ({ ...all, [server.memberId]: next }));
    try {
      const res = await fetch(memberApi(server.memberId, "/api/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences: { panel_update_interval: next } }),
      });
      if (!res.ok) throw new Error(MSG.saveFailed);
      toast.success(`${server.memberName}: controllo ogni ${PANEL_UPDATE_INTERVAL_LABELS[next]}`);
      await refresh();
    } catch {
      toast.error(`${server.memberName}: ${MSG.saveFailed}`);
      setIntervals((all) => {
        const copy = { ...all };
        if (previous) copy[server.memberId] = previous;
        else delete copy[server.memberId];
        return copy;
      });
    }
  }

  const header = (
    <PageHeader
      title="Aggiornamenti"
      description="La versione di ogni server, nodi compresi, e gli aggiornamenti in arrivo. Ogni server controlla da sé con la frequenza scelta qui; aggiornare resta una tua decisione."
      actions={
        <>
          <ServerFilter />
          {checkable.length > 1 && (
            <Button size="sm" variant="ghost" isPending={checking.size > 1} onPress={() => void check(checkable)}>
              <Icon icon="solar:refresh-linear" width={16} aria-hidden />
              Controlla tutti
            </Button>
          )}
          {updatable.length > 1 && (
            <Button size="sm" variant="primary" onPress={() => setConfirming("all")}>
              Aggiorna tutti ({updatable.length})
            </Button>
          )}
        </>
      }
    />
  );

  if (loading && !data) return <PageSkeleton title="Aggiornamenti" tiles={0} />;
  if (!data && error) {
    return (
      <>
        {header}
        <LoadError what="gli aggiornamenti" error={error} onRetry={() => void refresh()} />
      </>
    );
  }

  const confirmTitle =
    confirming === "all"
      ? `Aggiornare RunPanel su ${updatable.length} server?`
      : confirming
        ? `Aggiornare RunPanel su ${confirming.memberName}?`
        : "Aggiornare RunPanel?";
  const confirmText =
    confirming === "all"
      ? `${updatable.map((s) => s.memberName).join(", ")}: ognuno scarica la nuova versione, installa, builda e si riavvia, e per qualche secondo risulta non raggiungibile. Questo pannello parte per ultimo. I progetti e i servizi in esecuzione non vengono toccati.`
      : "Il server scarica la nuova versione, installa, builda e si riavvia: per qualche secondo risulta non raggiungibile. I progetti e i servizi in esecuzione non vengono toccati.";

  return (
    <>
      {header}
      <Panel padding="flush">
        <ul className="divide-border divide-y">
          {servers.map((server) => {
            const status = server.data;
            const active = status ? isUpdateActive(status) : false;
            const available = status ? hasUpdate(status) : false;
            const manual = status?.canUpdate.restart === "manual";
            const interval = status ? (intervals[server.memberId] ?? intervalOf(status)) : null;
            const notes = status
              ? [
                  `Ultimo controllo ${formatRelative(status.check?.checkedAt ?? null)}`,
                  !isOwner && interval ? `controllo automatico ogni ${PANEL_UPDATE_INTERVAL_LABELS[interval]}` : null,
                  status.check?.error ?? null,
                  status.blocker?.reason ?? null,
                  !status.canUpdate.ok ? status.canUpdate.reason : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : (server.error ?? "");
            return (
              <li key={server.memberId} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon icon="solar:server-2-linear" width={16} className="text-muted" aria-hidden />
                    <span className="text-foreground font-medium">{server.memberName}</span>
                    {server.memberId === selfId && <span className="text-muted text-xs">(questo)</span>}
                    {status && <span className="text-muted font-mono text-xs">{status.release.label}</span>}
                    <span
                      className={cn(
                        "rounded-md px-1.5 py-0.5 text-xs",
                        !status
                          ? "bg-danger/10 text-danger"
                          : active
                            ? "bg-accent/10 text-accent"
                            : available
                              ? "bg-warning/10 text-warning"
                              : "bg-success/10 text-success"
                      )}
                    >
                      {!status
                        ? server.reachable
                          ? "non disponibile"
                          : "non raggiungibile"
                        : active
                          ? "aggiornamento in corso"
                          : available
                            ? `${status.check?.behind} commit in arrivo`
                            : "aggiornato"}
                    </span>
                  </div>
                  <p className="text-muted mt-1 text-xs">{notes}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {status && isOwner && interval && (
                    <SelectField
                      ariaLabel={`Controllo automatico su ${server.memberName}`}
                      className="w-36"
                      value={interval}
                      onChange={(next) => void saveInterval(server, next)}
                      options={INTERVAL_OPTIONS}
                    />
                  )}
                  {status && (
                    <Button size="sm" variant="ghost" isPending={checking.has(server.memberId)} onPress={() => void check([server])}>
                      Controlla
                    </Button>
                  )}
                  {canApply(status) && (
                    <Button size="sm" variant="primary" onPress={() => setConfirming(server)}>
                      {manual ? "Prepara" : "Aggiorna"}
                    </Button>
                  )}
                  {status && <LinkButton href={href("/updates", server.memberId)}>{active ? "Segui" : "Dettagli"}</LinkButton>}
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      <ConfirmDialog
        isOpen={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={confirmTitle}
        confirmLabel={confirming === "all" ? "Aggiorna tutti" : "Aggiorna e riavvia"}
        description={confirmText}
        onConfirm={() => (confirming ? apply(confirming) : undefined)}
      />
    </>
  );
}
