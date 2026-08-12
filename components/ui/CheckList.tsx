"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * A list of health checks, each with the action that fixes it next to it.
 *
 * The rule this exists to enforce: a problem is never reported without saying
 * what to do about it. Either there is a button that fixes it, or a link to the
 * page where it can be fixed — a check that only says "something is wrong" is a
 * check that makes the panel feel broken rather than helpful.
 */

export type CheckTone = "ok" | "warn" | "danger" | "neutral";

export interface Check {
  id: string;
  title: string;
  tone: CheckTone;
  detail: string;
  fix?: { label: string; endpoint: string; body?: Record<string, unknown> };
  href?: string;
}

const TONE_ICON: Record<CheckTone, { icon: string; className: string }> = {
  ok: { icon: "solar:check-circle-linear", className: "text-success" },
  warn: { icon: "solar:danger-triangle-linear", className: "text-warning" },
  danger: { icon: "solar:close-circle-linear", className: "text-danger" },
  neutral: { icon: "solar:info-circle-linear", className: "text-muted" },
};

export function CheckList({
  checks,
  onChanged,
  className,
}: {
  checks: Check[];
  onChanged?: () => void;
  className?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function applyFix(check: Check) {
    if (!check.fix) return;
    setBusy(check.id);
    try {
      const res = await fetch(check.fix.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(check.fix.body ?? {}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok !== false) {
        toast.success(body.message ?? "Fatto");
        onChanged?.();
      } else {
        toast.error(body.error ?? body.message ?? "Non riuscito");
      }
    } catch {
      toast.error("Non riuscito");
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className={cn("divide-border divide-y", className)}>
      {checks.map((check) => {
        const tone = TONE_ICON[check.tone];
        return (
          <li key={check.id} className="flex items-start gap-3 py-3">
            <Icon icon={tone.icon} width={16} className={cn("mt-0.5 shrink-0", tone.className)} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-foreground text-sm">{check.title}</p>
              <p className="text-muted mt-0.5 text-xs">{check.detail}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {check.fix && (
                <Button
                  size="sm"
                  variant="secondary"
                  isPending={busy === check.id}
                  onPress={() => applyFix(check)}
                >
                  {check.fix.label}
                </Button>
              )}
              {check.href && check.tone !== "ok" && (
                <Link
                  href={check.href}
                  className="text-muted hover:text-foreground text-xs underline"
                >
                  Vai
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
