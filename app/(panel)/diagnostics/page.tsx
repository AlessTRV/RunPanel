"use client";

import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { CheckList, type Check } from "@/components/ui/CheckList";
import { Hint } from "@/components/ui/Hint";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { StatTile } from "@/components/ui/StatTile";
import { useResource } from "@/lib/hooks/useResource";

interface DiagnosticsData {
  checks: Check[];
  tone: "ok" | "warn" | "danger";
  problems: number;
}

export default function DiagnosticsPage() {
  const { data, loading, refresh } = useResource<DiagnosticsData>("/api/diagnostics", {
    intervalMs: 30_000,
  });

  if (loading && !data) {
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

  const checks = data?.checks ?? [];
  const problems = checks.filter((check) => check.tone !== "ok" && check.tone !== "neutral");
  const fine = checks.filter((check) => check.tone === "ok" || check.tone === "neutral");

  return (
    <>
      <PageHeader
        title="Diagnostica"
        description="Che cosa funziona su questa macchina, e che cosa succederebbe se si riavviasse adesso."
        actions={
          <Button size="sm" variant="secondary" onPress={refresh}>
            <Icon icon="solar:refresh-linear" width={16} aria-hidden />
            Ricontrolla
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatTile
          label="Controlli"
          icon="solar:list-check-linear"
          value={String(checks.length)}
          hint="eseguiti adesso"
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
          value={data?.tone === "ok" ? "a posto" : data?.tone === "warn" ? "attenzione" : "problemi"}
        />
      </div>

      <div className="space-y-4">
        {problems.length > 0 && (
          <Panel>
            <PanelHeader
              title="Da sistemare"
              description="Ognuno di questi ha accanto il modo per risolverlo."
            />
            <CheckList checks={problems} onChanged={refresh} className="mt-2" />
          </Panel>
        )}

        {problems.length === 0 && (
          <Hint tone="tip" title="Tutto in ordine">
            Nessun problema rilevato. Vale comunque la pena provare un ripristino ogni tanto: un
            backup che non è mai stato ripristinato è un backup di cui non sai niente.
          </Hint>
        )}

        <Panel>
          <PanelHeader title="Tutti i controlli" />
          <CheckList checks={fine} onChanged={refresh} className="mt-2" />
        </Panel>
      </div>
    </>
  );
}
