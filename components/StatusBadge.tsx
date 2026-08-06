import { cn } from "@/lib/utils";
import { statusMeta, TONE_DOT, TONE_SOFT } from "@/lib/status";

interface StatusBadgeProps {
  status: string;
  /** `dot` is for dense lists where a full chip would be noise. */
  variant?: "chip" | "dot";
  className?: string;
}

export function StatusBadge({ status, variant = "chip", className }: StatusBadgeProps) {
  const meta = statusMeta(status);

  if (variant === "dot") {
    return (
      <span className={cn("inline-flex items-center gap-2", className)}>
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            TONE_DOT[meta.tone],
            meta.active && "animate-pulse"
          )}
        />
        <span className="text-muted text-xs">{meta.label}</span>
        <span className="sr-only">Stato: {meta.label}</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        TONE_SOFT[meta.tone],
        className
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", TONE_DOT[meta.tone], meta.active && "animate-pulse")}
      />
      {meta.label}
    </span>
  );
}
