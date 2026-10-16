"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { CheckList, type Check } from "@/components/ui/CheckList";
import { useResource } from "@/lib/hooks/useResource";
import { useCan } from "@/lib/hooks/useMe";
import { useMemberApi, useNode, useServerHref } from "@/lib/hooks/useNode";
import type { PerServer } from "@/lib/cluster-merge";
import { cn } from "@/lib/utils";

/**
 * What needs attention, at the top of the Overview.
 *
 * It renders `/api/diagnostics` and nothing else — no second opinion computed
 * here. That is what keeps this a renderer rather than a source of truth, and
 * it is why adding a new check is one edit in `services/diagnostics.ts` instead
 * of two that can disagree. In a cluster it renders every server's, grouped by
 * server, with each fix sent to the server it is about.
 *
 * When everything is fine it collapses to a single line. A dashboard that
 * devotes a third of the screen to saying "no problems" trains people not to
 * look at it.
 */

interface Diagnostics {
  checks: Check[];
  tone: string;
  problems: number;
}

interface Problem {
  check: Check;
  memberId: string | null;
  memberName: string;
}

export function HealthBanner() {
  const { isSolo, serverParam } = useNode();
  const memberApi = useMemberApi();
  const href = useServerHref();
  // Diagnostics are for accounts holding that permission; nobody else polls.
  const canDiagnose = useCan("diagnostics");
  const solo = useResource<Diagnostics>(canDiagnose && isSolo ? "/api/diagnostics" : null, { intervalMs: 60_000 });
  const cluster = useResource<{ servers: PerServer<Diagnostics>[] }>(canDiagnose && !isSolo ? "/api/cluster/diagnostics" : null, {
    intervalMs: 60_000,
  });
  const [expanded, setExpanded] = useState(false);

  const data = isSolo ? solo.data : cluster.data;
  const error = isSolo ? solo.error : cluster.error;
  const refresh = isSolo ? solo.refresh : cluster.refresh;

  // A failed check is not "nothing to report": silence here used to read as a
  // healthy machine. One quiet line, the same size as the all-clear.
  if (!data && error) {
    return (
      <div role="status" className="text-muted mb-6 flex flex-wrap items-center gap-2 text-xs">
        <Icon icon="solar:danger-triangle-linear" width={14} className="text-warning" aria-hidden />
        Controlli di salute non disponibili ({error}).
        <button type="button" onClick={() => void refresh()} className="hover:text-foreground underline">
          Riprova
        </button>
      </div>
    );
  }
  if (!data) return null;

  const isBad = (check: Check) => check.tone === "warn" || check.tone === "danger";
  const servers = isSolo ? [] : (cluster.data?.servers ?? []).filter((s) => !serverParam || s.memberId === serverParam);
  const problems: Problem[] = isSolo
    ? (solo.data?.checks ?? []).filter(isBad).map((check) => ({ check, memberId: null, memberName: "" }))
    : servers.flatMap((s) => (s.data?.checks ?? []).filter(isBad).map((check) => ({ check, memberId: s.memberId, memberName: s.memberName })));
  const silent = servers.filter((s) => !s.data && !s.reachable);
  const diagnosticsLink = href("/diagnostics");

  if (problems.length === 0) {
    return (
      <div className="text-muted mb-6 flex flex-wrap items-center gap-2 text-xs">
        <Icon icon="solar:check-circle-linear" width={14} className="text-success" aria-hidden />
        Nessun problema rilevato{silent.length > 0 ? ` (non raggiungibile: ${silent.map((s) => s.memberName).join(", ")})` : ""}.
        <Link href={diagnosticsLink} className="hover:text-foreground underline">
          Diagnostica
        </Link>
      </div>
    );
  }

  const worst = problems.some((p) => p.check.tone === "danger") ? "danger" : "warn";
  const visible = expanded ? problems : problems.slice(0, 3);
  const where = isSolo ? [] : [...new Set(problems.map((p) => p.memberName))];
  const groups = [...new Set(visible.map((p) => p.memberId))].map((memberId) => ({
    memberId,
    memberName: visible.find((p) => p.memberId === memberId)?.memberName ?? "",
    checks: visible.filter((p) => p.memberId === memberId).map((p) => p.check),
  }));

  return (
    <Panel className={cn("mb-6", worst === "danger" ? "border-danger/35" : "border-warning/35")}>
      <PanelHeader
        title={
          <span className="flex flex-wrap items-center gap-x-2">
            <Icon
              icon="solar:danger-triangle-linear"
              width={15}
              className={worst === "danger" ? "text-danger" : "text-warning"}
              aria-hidden
            />
            {problems.length === 1 ? "Una cosa da sistemare" : `${problems.length} cose da sistemare`}
            {where.length > 0 && <span className="text-muted font-normal">su {where.join(", ")}</span>}
          </span>
        }
        actions={
          <Link href={diagnosticsLink} className="text-muted hover:text-foreground text-xs underline">
            Diagnostica
          </Link>
        }
      />

      {groups.map((group) => (
        <div key={group.memberId ?? "self"}>
          {!isSolo && groups.length > 1 && <p className="text-muted mt-3 text-xs font-medium">{group.memberName}</p>}
          <CheckList
            checks={group.checks}
            onChanged={refresh}
            className="mt-1"
            apiFor={group.memberId ? (path) => memberApi(group.memberId, path) : undefined}
            hrefFor={group.memberId ? (h) => href(h, group.memberId) : undefined}
          />
        </div>
      ))}

      {problems.length > 3 && (
        <button
          type="button"
          className="text-muted hover:text-foreground mt-2 text-xs underline"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Mostra meno" : `Mostra le altre ${problems.length - 3}`}
        </button>
      )}
    </Panel>
  );
}
