import Link from "next/link";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

/** Title, optional subtitle and actions — the top of every page. */
export function PageHeader({
  title,
  description,
  actions,
  back,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /**
   * The list a detail page belongs to. The project page had its own arrow and
   * the service page none, so the way back from a detail depended on which
   * detail it was.
   */
  back?: { href: string; label: string };
  className?: string;
}) {
  return (
    <header className={cn("mb-6 flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="flex min-w-0 items-start gap-3">
        {back && (
          <Link
            href={back.href}
            aria-label={back.label}
            title={back.label}
            className="text-muted hover:text-foreground hover:bg-surface-hover mt-1 shrink-0 rounded-[var(--radius)] p-1.5 transition-colors"
          >
            <Icon icon="solar:arrow-left-linear" width={18} aria-hidden />
          </Link>
        )}
        <div className="min-w-0">
          <h1 className="text-foreground truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-muted mt-1 text-sm">{description}</p>}
        </div>
      </div>
      {/* Wraps instead of refusing to shrink: with `shrink-0` four buttons on a
          phone pushed the whole page sideways. */}
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
