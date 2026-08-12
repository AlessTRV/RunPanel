"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { NAV_ITEMS, isActiveNav } from "@/lib/nav";

/**
 * Navigation for a phone: four destinations under the thumb, the rest behind a
 * drawer that opens from the right.
 *
 * The panel is used from a phone routinely, and the only mobile affordance was
 * a hamburger pinned to the TOP LEFT — the far corner from where a thumb rests,
 * on every screen, for all ten destinations. Overview, Progetti, Servizi and
 * Monitor are the ones opened daily; the other six are configuration, visited
 * when something needs changing.
 *
 * Both live here rather than inside the sidebar because the sidebar is a
 * desktop layout that happened to also render a drawer. Splitting them means
 * neither has to carry `md:hidden` on every line.
 */

/** The four kept in the bar, in the order they are used. */
const PRIMARY = ["/home", "/projects", "/services", "/monitor"];

export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Escape closes it, and the page behind must not scroll while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const primary = PRIMARY.map((href) => NAV_ITEMS.find((item) => item.href === href)!).filter(
    Boolean
  );
  const rest = NAV_ITEMS.filter((item) => !PRIMARY.includes(item.href));

  return (
    <>
      {/* Opens the rest of the navigation, top right — reachable, and out of the
          way of the back gesture on the left edge. */}
      <button
        type="button"
        className="border-border bg-surface text-foreground fixed top-3 right-3 z-50 flex size-9 items-center justify-center rounded-[var(--radius)] border md:hidden"
        onClick={() => setOpen(true)}
        aria-label="Apri il menu"
        aria-expanded={open}
        aria-controls="mobile-drawer"
      >
        <Icon icon="solar:hamburger-menu-linear" width={18} aria-hidden />
      </button>

      {open && (
        <div
          className="bg-backdrop fixed inset-0 z-40 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <aside
        id="mobile-drawer"
        aria-label="Tutte le sezioni"
        aria-hidden={!open}
        className={cn(
          "border-border bg-surface fixed top-0 right-0 z-50 flex h-dvh w-72 max-w-[85vw] flex-col border-l md:hidden",
          "transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        <div className="border-border flex h-14 items-center gap-2.5 border-b px-4">
          <span className="text-foreground text-sm font-semibold tracking-tight">RunPanel</span>
          <button
            type="button"
            className="text-muted hover:text-foreground ml-auto"
            onClick={() => setOpen(false)}
            aria-label="Chiudi il menu"
          >
            <Icon icon="solar:close-circle-linear" width={20} aria-hidden />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {rest.map((item) => {
            const active = isActiveNav(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                // Closed on the click rather than in an effect on `pathname`:
                // the click is the event.
                onClick={() => setOpen(false)}
                aria-current={active ? "page" : undefined}
                tabIndex={open ? undefined : -1}
                className={cn(
                  "flex items-center gap-3 rounded-[var(--radius)] px-3 py-2.5 text-sm transition-colors",
                  active
                    ? "bg-default text-foreground font-medium"
                    : "text-muted hover:bg-surface-hover hover:text-foreground"
                )}
              >
                <Icon icon={item.icon} width={18} aria-hidden />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/*
        The bar itself. `pb-[env(safe-area-inset-bottom)]` keeps it clear of the
        home indicator on a modern phone, where a fixed bar otherwise sits under
        the gesture area and swallows the last few pixels of every tap.
      */}
      <nav
        aria-label="Navigazione principale"
        className="border-border bg-surface/95 fixed inset-x-0 bottom-0 z-30 flex border-t pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {primary.map((item) => {
          const active = isActiveNav(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 py-2 text-meta transition-colors",
                active ? "text-foreground" : "text-muted"
              )}
            >
              <Icon icon={item.icon} width={20} aria-hidden />
              <span className="truncate px-1">{item.label}</span>
              {active && <span className="bg-accent h-0.5 w-6 rounded-full" />}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
