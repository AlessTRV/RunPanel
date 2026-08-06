import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

/**
 * Replaces five hand-rolled empty states that each looked slightly different.
 * An empty state should say what is missing and offer the one action that fixes
 * it — anything more is decoration.
 */
export function EmptyState({
  icon = "solar:inbox-line-duotone",
  title,
  description,
  action,
  className,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-12 text-center",
        className
      )}
    >
      <Icon icon={icon} width={32} className="text-muted/60" aria-hidden />
      <p className="text-foreground mt-3 text-sm font-medium">{title}</p>
      {description && <p className="text-muted mt-1 max-w-sm text-xs">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
