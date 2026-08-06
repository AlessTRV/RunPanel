import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

/**
 * A single metric. Deliberately plain: the number is the content, everything
 * else is chrome. The optional bar is the only place a stat uses colour, and it
 * uses the accent rather than a per-metric hue — five differently coloured tiles
 * imply a meaning that is not there.
 */
export function StatTile({
  label,
  value,
  hint,
  icon,
  /** 0–100. Omit for metrics that have no ceiling (uptime, counts). */
  percent,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: string;
  percent?: number;
  className?: string;
}) {
  const clamped = percent === undefined ? undefined : Math.max(0, Math.min(100, percent));

  return (
    <div
      className={cn(
        "border-border bg-surface rounded-[var(--radius)] border p-4",
        className
      )}
    >
      <div className="flex items-center gap-2">
        {icon && <Icon icon={icon} width={15} className="text-muted" aria-hidden />}
        <span className="text-muted text-xs font-medium">{label}</span>
      </div>

      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-foreground text-2xl font-semibold tabular-nums tracking-tight">
          {value}
        </span>
        {hint && <span className="text-muted text-xs">{hint}</span>}
      </div>

      {clamped !== undefined && (
        <div
          className="bg-default mt-3 h-1 w-full overflow-hidden rounded-full"
          role="meter"
          aria-valuenow={Math.round(clamped)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        >
          <div
            className="bg-accent h-full rounded-full transition-[width] duration-500"
            style={{ width: `${clamped}%` }}
          />
        </div>
      )}
    </div>
  );
}
