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
import { PageSkeleton } from "@/components/ui/Skeletons";
import { ServerFilter } from "@/components/cluster/ServerBits";
import { useResource } from "@/lib/hooks/useResource";
import { useMemberApi, useNode, useServerHref } from "@/lib/hooks/useNode";
import { formatRelative } from "@/lib/format";
import { MSG } from "@/lib/copy";
import { hasUpdate, isUpdateActive, type UpdateStatus } from "@/lib/panel-update";
import type { PerServer } from "@/lib/cluster-merge";
import { cn } from "@/lib/utils";

/**
 * Updates of every server on one page: version, what is waiting, and the
 * button, per server. The details — commits, the live log, the settings —
 * stay on each server's own page, one click away.
 */
export function UpdatesOverview() {
  const { selfId } = useNode();
  const memberApi = useMemberApi();
  const href = useServerHref();
  const { data, error, loading, refresh } = useResource<{ servers: PerServer<UpdateStatus>[] }>("/api/cluster/updates", {
    intervalMs: 15_000,
  });
  const [confirming, setConfirming] = useState<PerServer<UpdateStatus> | null>(null);
  const [checking, setChecking] = useState<string | null>(null);

  async function check(server: PerServer<UpdateStatus>) {
    setChecking(server.memberId);
    try {
      const res = await fetch(memberApi(server.memberId, "/api/updates/check"), { method: "POST" });
      if (!res.ok) toast.error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Controllo non riuscito");
      await refresh();
    } finally {
      setChecking(null);
    }
  }

  async function apply(server: PerServer<UpdateStatus>) {
    try {
      const res = await fetch(memberApi(server.memberId, "/api/updates/apply"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedSha: server.data?.check?.remoteSha ?? null }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? MSG.updateFailed);
        return false;
      }
      toast.success(`Aggiornamento avviato su ${server.memberName}`);
      await refresh();
    } catch {
      toast.error(MSG.unreachable);
      return false;
    }
  }

  const header = (
    <PageHeader
      title="Aggiornamenti"
      description="La versione di ogni server e gli aggiornamenti in arrivo. I dettagli e il log sono nella pagina di ciascun server."
      actions={<ServerFilter />}
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

  return (
    <>
      {header}
      <Panel padding="flush">
        <ul className="divide-border divide-y">
          {(data?.servers ?? []).map((server) => {
            const status = server.data;
            const active = status ? isUpdateActive(status) : false;
            const available = status ? hasUpdate(status) : false;
            const manual = status?.canUpdate.restart === "manual";
            const blocked = !status || Boolean(status.blocker) || (!status.canUpdate.ok && !manual);
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
                  <p className="text-muted mt-1 text-xs">
                    {status
                      ? `Ultimo controllo ${formatRelative(status.check?.checkedAt ?? null)}${status.blocker ? ` · ${status.blocker.reason}` : ""}`
                      : (server.error ?? "")}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {status && (
                    <Button size="sm" variant="ghost" isPending={checking === server.memberId} onPress={() => check(server)}>
                      Controlla
                    </Button>
                  )}
                  {available && !active && !blocked && (
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
        title={confirming ? `Aggiornare RunPanel su ${confirming.memberName}?` : "Aggiornare RunPanel?"}
        confirmLabel="Aggiorna e riavvia"
        description="Il server scarica la nuova versione, installa, builda e si riavvia: per qualche secondo risulta non raggiungibile. I progetti e i servizi in esecuzione non vengono toccati."
        onConfirm={() => (confirming ? apply(confirming) : undefined)}
      />
    </>
  );
}
