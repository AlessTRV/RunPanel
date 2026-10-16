"use client";

import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadError } from "@/components/ui/LoadError";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { CheckList, type Check } from "@/components/ui/CheckList";
import { Hint } from "@/components/ui/Hint";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { StatTile } from "@/components/ui/StatTile";
import { ServerFilter } from "@/components/cluster/ServerBits";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { formatRelative } from "@/lib/format";
import { useMemberApi, useNode, useServerHref } from "@/lib/hooks/useNode";
import type { PerServer } from "@/lib/cluster-merge";

interface DiagnosticsData {
  checks: Check[];
  tone: "ok" | "warn" | "danger";
  problems: number;
  /** When the reading being shown was taken, not when it was asked for. */
  checkedAt: string;
}

/** One server's checks: the three tiles, then what needs doing, then what passed. */
function ServerDiagnostics({
  data,
  onChanged,
  apiFor,
  hrefFor,
}: {
  data: DiagnosticsData;
  onChanged: () => void;
  apiFor?: (path: string) => string;
  hrefFor?: (href: string) => string;
}) {
  const checks = data.checks ?? [];
  const problems = checks.filter((check) => check.tone !== "ok" && check.tone !== "neutral");
  const fine = checks.filter((check) => check.tone === "ok" || check.tone === "neutral");

  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatTile
          label="Controlli"
          icon="solar:list-check-linear"
          value={String(checks.length)}
          /*
            This said "eseguiti adesso", which was untrue for up to thirty
            seconds and unfalsifiable from the screen. It is also the only way
            to tell a re-check that found nothing changed from one that never
            ran — which is what "Ricontrolla" looked like for its whole life.
          */
          hint={formatRelative(data.checkedAt)}
        />
        <StatTile
          label="Da sistemare"
          icon="solar:danger-triangle-linear"
          value={String(problems.length)}
          hint={problems.length === 0 ? "niente da fare" : "vedi sotto"}
        />
        <StatTile
          label="Stato"
          icon="solar:health-linear"
          value={data.tone === "ok" ? "a posto" : data.tone === "warn" ? "attenzione" : "problemi"}
        />
      </div>

      <div className="space-y-4">
        {problems.length > 0 && (
          <Panel>
            <PanelHeader title="Da sistemare" description="Ognuno di questi ha accanto il modo per risolverlo." />
            <CheckList checks={problems} onChanged={onChanged} className="mt-2" apiFor={apiFor} hrefFor={hrefFor} />
          </Panel>
        )}

        {problems.length === 0 && (
          <Hint tone="tip" title="Tutto in ordine">
            Nessun problema rilevato. Vale comunque la pena provare un ripristino ogni tanto: un backup che non è mai
            stato ripristinato è un backup di cui non sai niente.
          </Hint>
        )}

        <Panel>
          <PanelHeader title="Controlli superati" />
          <CheckList checks={fine} onChanged={onChanged} className="mt-2" apiFor={apiFor} hrefFor={hrefFor} />
        </Panel>
      </div>
    </>
  );
}

export default function DiagnosticsPage() {
  const { isSolo, serverParam, selfId } = useNode();
  const memberApi = useMemberApi();
  const href = useServerHref();
  const poll30000 = usePollInterval(30_000);

  // Polling takes the 30s cache — the checks shell out to docker, pm2 and
  // systemctl, and this page is not the only one asking. "Ricontrolla" means
  // run them again, so it asks a different question. In a cluster the panel
  // asks every server the same way.
  const solo = useResource<DiagnosticsData>(isSolo ? "/api/diagnostics" : null, {
    intervalMs: poll30000,
    refreshUrl: "/api/diagnostics?fresh=1",
  });
  const cluster = useResource<{ servers: PerServer<DiagnosticsData>[] }>(isSolo ? null : "/api/cluster/diagnostics", {
    intervalMs: poll30000,
    refreshUrl: "/api/cluster/diagnostics?fresh=1",
  });
  const active = isSolo ? solo : cluster;

  const description = isSolo
    ? "Che cosa funziona su questa macchina, e che cosa succederebbe se si riavviasse adesso."
    : "Che cosa funziona su ogni server, e che cosa succederebbe se si riavviasse adesso.";
  const actions = (
    <>
      <ServerFilter />
      <Button size="sm" variant="secondary" isPending={active.refreshing} onPress={active.refresh}>
        <Icon icon="solar:refresh-linear" width={16} aria-hidden />
        Ricontrolla
      </Button>
    </>
  );

  // Without data there is no verdict: "Tutto in ordine" over zero checks lied.
  if (!active.data && active.error) {
    return (
      <>
        <PageHeader title="Diagnostica" />
        <LoadError what="la diagnostica" error={active.error} onRetry={() => void active.refresh()} />
      </>
    );
  }

  if (active.loading && !active.data) {
    return (
      <>
        <PageHeader title="Diagnostica" />
        <div className="space-y-4">
          <SkeletonBlock className="h-24" />
          <SkeletonBlock className="h-96" />
        </div>
      </>
    );
  }

  if (isSolo) {
    return (
      <>
        <PageHeader title="Diagnostica" description={description} actions={actions} />
        {solo.data && <ServerDiagnostics data={solo.data} onChanged={() => void solo.refresh()} />}
      </>
    );
  }

  const servers = (cluster.data?.servers ?? []).filter((s) => !serverParam || s.memberId === serverParam);
  return (
    <>
      <PageHeader title="Diagnostica" description={description} actions={actions} />
      <div className="space-y-10">
        {servers.map((server) => (
          <section key={server.memberId} aria-label={`Server ${server.memberName}`}>
            <h2 className="text-foreground mb-3 flex items-center gap-2 text-sm font-semibold">
              <Icon icon="solar:server-2-linear" width={16} className="text-muted" aria-hidden />
              {server.memberName}
              {server.memberId === selfId && <span className="text-muted font-normal">(questo)</span>}
            </h2>
            {server.data ? (
              <ServerDiagnostics
                data={server.data}
                onChanged={() => void cluster.refresh()}
                apiFor={(path) => memberApi(server.memberId, path)}
                hrefFor={(h) => href(h, server.memberId)}
              />
            ) : (
              <Hint tone={server.reachable ? "info" : "warn"}>
                {server.reachable
                  ? `La diagnostica di ${server.memberName} non è disponibile per il tuo account (${server.error ?? "accesso negato"}).`
                  : `${server.memberName} non raggiungibile. ${server.error ?? ""}`}
              </Hint>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
