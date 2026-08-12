"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { NAV_ITEMS, isActiveNav } from "@/lib/nav";

/**
 * The desktop navigation, and only that.
 *
 * It used to be both: a fixed sidebar on wide screens and, below `md`, a drawer
 * driven by a hamburger in the top-left corner — the furthest point from a
 * thumb, for all ten destinations. Every line carried a `md:hidden` or a
 * translate rule for the other mode.
 *
 * Mobile now has its own component with a different shape entirely, so this one
 * is a list that is always there.
 */
export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="border-border bg-surface/80 fixed top-0 left-0 z-40 hidden h-dvh w-64 flex-col border-r backdrop-blur-xl md:flex">
      <div className="border-border flex h-14 items-center gap-2.5 border-b px-4">
        <span className="bg-foreground text-background text-meta flex size-6 items-center justify-center rounded-md font-bold">
          R
        </span>
        <span className="text-foreground text-sm font-semibold tracking-tight">RunPanel</span>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Navigazione principale">
        {NAV_ITEMS.map((item) => {
          const active = isActiveNav(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex items-center gap-3 rounded-[var(--radius)] px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-default text-foreground font-medium"
                  : "text-muted hover:bg-surface-hover hover:text-foreground"
              )}
            >
              {active && (
                <span className="bg-accent absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full" />
              )}
              <Icon icon={item.icon} width={18} aria-hidden />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-border text-muted text-meta border-t px-4 py-3">
        <span className="font-mono">v0.1.0</span>
      </div>
    </aside>
  );
}
