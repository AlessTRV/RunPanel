import { cn } from "@/lib/utils";

/**
 * The one card surface.
 *
 * The app previously had four competing recipes: HeroUI's own Card, a
 * 14px-radius translucent-white variant, a 12px one with a different tint, and
 * a blurred black glass copied inline four times in a single file. Every panel
 * now comes from here, so a change to elevation or radius happens in one place.
 */

interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** `flush` drops the padding for panels that host their own scroll area. */
  padding?: "default" | "compact" | "flush";
  /** Slightly lighter surface, for panels nested inside another panel. */
  nested?: boolean;
  interactive?: boolean;
}

const PADDING = {
  default: "p-4 sm:p-5",
  compact: "p-3",
  flush: "p-0",
} as const;

export function Panel({
  padding = "default",
  nested = false,
  interactive = false,
  className,
  children,
  ...props
}: PanelProps) {
  return (
    <div
      className={cn(
        "border-border rounded-[var(--radius)] border",
        nested ? "bg-surface-secondary" : "bg-surface",
        PADDING[padding],
        interactive && "hover:border-separator hover:bg-surface-hover transition-colors",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-foreground truncate text-sm font-medium">{title}</h2>
        {description && <p className="text-muted mt-0.5 text-xs">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
