"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  href: string;
  icon: string;
  /** Extra path prefixes that should also light this item up. */
  owns?: string[];
}

const NAV_ITEMS: NavItem[] = [
  { label: "Overview", href: "/home", icon: "solar:widget-2-linear" },
  { label: "Progetti", href: "/projects", icon: "solar:folder-linear" },
  { label: "Servizi", href: "/services", icon: "solar:database-linear" },
  { label: "Monitor", href: "/monitor", icon: "solar:chart-2-linear" },
  { label: "Storage", href: "/storage", icon: "solar:ssd-square-linear" },
  { label: "Backup", href: "/backups", icon: "solar:archive-linear" },
  { label: "Avvio", href: "/autostart", icon: "solar:power-linear" },
  { label: "Diagnostica", href: "/diagnostics", icon: "solar:health-linear" },
  { label: "GitHub", href: "/github", icon: "solar:code-linear" },
  { label: "Impostazioni", href: "/account", icon: "solar:settings-linear", owns: ["/settings"] },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return (item.owns ?? []).some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function AppSidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Escape closes it, and the page behind must not scroll while it is open.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <>
      <button
        type="button"
        className="border-border bg-surface text-foreground fixed top-3 left-3 z-50 flex size-9 items-center justify-center rounded-[var(--radius)] border md:hidden"
        onClick={() => setMobileOpen(true)}
        aria-label="Apri il menu"
        aria-expanded={mobileOpen}
        aria-controls="app-sidebar"
      >
        <Icon icon="solar:hamburger-menu-linear" width={18} />
      </button>

      {mobileOpen && (
        <div
          className="bg-backdrop fixed inset-0 z-30 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      <aside
        id="app-sidebar"
        className={cn(
          "border-border bg-surface/80 fixed top-0 left-0 z-40 flex h-dvh w-64 flex-col border-r backdrop-blur-xl",
          "transition-transform duration-200 ease-out",
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        )}
      >
        <div className="border-border flex h-14 items-center gap-2.5 border-b px-4">
          <span className="bg-foreground text-background flex size-6 items-center justify-center rounded-md text-[11px] font-bold">
            R
          </span>
          <span className="text-foreground text-sm font-semibold tracking-tight">RunPanel</span>

          <button
            type="button"
            className="text-muted hover:text-foreground ml-auto md:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Chiudi il menu"
          >
            <Icon icon="solar:close-circle-linear" width={20} />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Navigazione principale">
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                // Closed here rather than in an effect on `pathname`: the click
                // is the event, and reacting to the route change afterwards
                // would be a render-triggered setState.
                onClick={() => setMobileOpen(false)}
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

        <div className="border-border text-muted border-t px-4 py-3 text-[11px]">
          <span className="font-mono">v0.1.0</span>
        </div>
      </aside>
    </>
  );
}
