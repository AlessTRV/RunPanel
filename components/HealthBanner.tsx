"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { CheckList, type Check } from "@/components/ui/CheckList";
import { useResource } from "@/lib/hooks/useResource";
import { cn } from "@/lib/utils";

/**
 * What needs attention, at the top of the Overview.
 *
 * It renders `/api/diagnostics` and nothing else — no second opinion computed
 * here. That is what keeps this a renderer rather than a source of truth, and
 * it is why adding a new check is one edit in `services/diagnostics.ts` instead
 * of two that can disagree.
 *
 * When everything is fine it collapses to a single line. A dashboard that
 * devotes a third of the screen to saying "no problems" trains people not to
 * look at it.
 */
export function HealthBanner() {
  const { data, refresh } = useResource<{ checks: Check[]; tone: string; problems: number }>(
    "/api/diagnostics",
    { intervalMs: 60_000 }
  );
  const [expanded, setExpanded] = useState(false);

  if (!data) return null;

  const problems = data.checks.filter(
    (check) => check.tone === "warn" || check.tone === "danger"
  );

  if (problems.length === 0) {
    return (
      <div className="text-muted mb-6 flex items-center gap-2 text-xs">
        <Icon icon="solar:check-circle-linear" width={14} className="text-success" aria-hidden />
        Nessun problema rilevato.
        <Link href="/diagnostics" className="hover:text-foreground underline">
          Diagnostica
        </Link>
      </div>
    );
  }

  const worst = problems.some((check) => check.tone === "danger") ? "danger" : "warn";
  const visible = expanded ? problems : problems.slice(0, 3);

  return (
    <Panel
      className={cn(
        "mb-6",
        worst === "danger" ? "border-danger/35" : "border-warning/35"
      )}
    >
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <Icon
              icon="solar:danger-triangle-linear"
              width={15}
              className={worst === "danger" ? "text-danger" : "text-warning"}
              aria-hidden
            />
            {problems.length === 1
              ? "Una cosa da sistemare"
              : `${problems.length} cose da sistemare`}
          </span>
        }
        actions={
          <Link href="/diagnostics" className="text-muted hover:text-foreground text-xs underline">
            Diagnostica
          </Link>
        }
      />

      <CheckList checks={visible} onChanged={refresh} className="mt-1" />

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
