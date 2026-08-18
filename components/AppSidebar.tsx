"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, isActiveNav, navItemsIn, type NavItem } from "@/lib/nav";
import { usePanelUpdate } from "@/lib/hooks/usePanelUpdate";
import { hasUpdate } from "@/lib/panel-update";

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
 *
 * The ten destinations sit in blocks rather than one undifferentiated column:
 * the four you open daily, the three you open when something needs checking,
 * and the two that are configuration, pinned to the bottom where a footer
 * belongs. The grouping lives in lib/nav.ts so the palette and the mobile
 * drawer read from the same list.
 */

/** One row of the rail. Shared by both the scrolling list and the pinned footer. */
function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-[var(--radius)] px-3 py-2 text-sm transition-colors",
        active
          ? "selected text-foreground font-medium"
          : "text-muted hover:bg-surface-hover hover:text-foreground"
      )}
    >
      {active && (
        <span
          aria-hidden
          className="bg-accent absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-full"
        />
      )}
      {/* The filled variant only while active. It is the difference between a
          row that is tinted and a row that looks drawn that way on purpose. */}
      <Icon
        icon={active ? item.iconActive : item.icon}
        width={18}
        aria-hidden
        className={cn("shrink-0", active && "text-accent")}
      />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {/* Only three destinations have a chord, and they really are bound —
          CommandPalette listens for them on `window`. Same treatment the
          palette uses, so the two places that mention shortcuts match. */}
      {item.keys && (
        <kbd
          aria-hidden
          className={cn(
            "text-muted border-border text-meta rounded border px-1.5 py-0.5 font-sans transition-opacity",
            active ? "opacity-70" : "opacity-0 group-hover:opacity-70"
          )}
        >
          {item.keys}
        </kbd>
      )}
    </Link>
  );
}

export function AppSidebar({ version }: { version: string }) {
  const pathname = usePathname();
  const footer = navItemsIn("footer");
  // Shared with the banner rather than fetched again — see `usePanelUpdate`.
  const { status } = usePanelUpdate();
  const updateReady = hasUpdate(status);

  return (
    <aside className="border-border bg-surface/80 fixed top-0 left-0 z-40 hidden h-dvh w-64 flex-col overflow-hidden border-r backdrop-blur-xl md:flex">
      {/* A single static gradient so the rail does not read as a flat slab.
          No filter, no blend mode — it paints once and never again. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[200px]"
        style={{ background: "var(--nav-sheen)" }}
      />

      <div className="border-border relative flex h-14 items-center gap-2.5 border-b px-4">
        <span className="bg-foreground text-background text-meta flex size-6 items-center justify-center rounded-md font-bold shadow-[var(--selected-shadow)]">
          R
        </span>
        <span className="text-foreground text-sm font-semibold tracking-tight">RunPanel</span>
      </div>

      <nav className="relative flex-1 overflow-y-auto p-2" aria-label="Navigazione principale">
        {NAV_GROUPS.map((group) => (
          <div key={group.id} className="space-y-0.5">
            {group.label && (
              <p className="text-muted/60 text-meta px-3 pt-4 pb-1.5 tracking-wider uppercase">
                {group.label}
              </p>
            )}
            {navItemsIn(group.id).map((item) => (
              <NavLink key={item.href} item={item} active={isActiveNav(pathname, item)} />
            ))}
          </div>
        ))}
      </nav>

      {/* Configuration, and the version. Outside the scroll area: these are the
          two you reach for deliberately, and a long list should not be able to
          push them out of sight. */}
      <div className="border-border relative space-y-0.5 border-t p-2">
        {footer.map((item) => (
          <NavLink key={item.href} item={item} active={isActiveNav(pathname, item)} />
        ))}
        {/* Read rather than written down. The literal that used to live here
            said v0.1.0 while package.json — which the backup manifest reads —
            was free to say something else. */}
        <p className="text-muted/60 text-meta flex items-center gap-1.5 px-3 pt-2 pb-1 font-mono">
          v{version}
          {updateReady && (
            <>
              {/* The banner can be dismissed; this cannot, so after closing it
                  there is still one place that remembers. */}
              <span className="bg-accent size-1.5 rounded-full" aria-hidden />
              <span className="sr-only">Aggiornamento disponibile</span>
            </>
          )}
        </p>
      </div>
    </aside>
  );
}
