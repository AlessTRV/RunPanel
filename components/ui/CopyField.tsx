"use client";

import { useState } from "react";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { useClipboard } from "@/lib/hooks/useClipboard";

/**
 * A read-only value with a copy button — connection strings, webhook URLs,
 * generated passwords. Secrets stay masked until explicitly revealed, so a
 * credential is not left on screen for a passing shoulder.
 */
export function CopyField({
  value,
  label,
  secret = false,
  className,
}: {
  value: string;
  label?: string;
  secret?: boolean;
  className?: string;
}) {
  const { copied, copy } = useClipboard();
  const [revealed, setRevealed] = useState(!secret);

  return (
    <div className={cn("space-y-1.5", className)}>
      {label && <span className="text-muted text-xs font-medium">{label}</span>}
      <div className="border-border bg-surface-secondary flex items-center gap-1 rounded-[var(--radius)] border px-3 py-2">
        <code className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {revealed ? value : "•".repeat(Math.min(value.length, 32))}
        </code>

        {secret && (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            className="text-muted hover:text-foreground rounded p-1 transition-colors"
            aria-label={revealed ? "Nascondi valore" : "Mostra valore"}
          >
            <Icon icon={revealed ? "solar:eye-closed-linear" : "solar:eye-linear"} width={15} />
          </button>
        )}

        <button
          type="button"
          onClick={() => copy(value)}
          className="text-muted hover:text-foreground rounded p-1 transition-colors"
          aria-label={`Copia${label ? ` ${label}` : ""}`}
        >
          <Icon icon={copied ? "solar:check-read-linear" : "solar:copy-linear"} width={15} />
        </button>
      </div>
    </div>
  );
}
