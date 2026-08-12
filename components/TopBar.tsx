"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";

const SEGMENT_LABELS: Record<string, string> = {
  home: "Overview",
  projects: "Progetti",
  services: "Servizi",
  monitor: "Monitor",
  storage: "Storage",
  backups: "Backup",
  policies: "Pianificazioni",
  runs: "Esecuzioni",
  restore: "Ripristino",
  autostart: "Avvio automatico",
  diagnostics: "Diagnostica",
  github: "GitHub",
  account: "Impostazioni",
  settings: "Impostazioni",
  new: "Nuovo",
};

interface Crumb {
  label: string;
  href: string;
  /** Opaque ids get truncated; real labels never do. */
  truncate: boolean;
}

function buildCrumbs(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: Crumb[] = [];
  let href = "";

  for (const segment of segments) {
    href += `/${segment}`;
    const known = SEGMENT_LABELS[segment];
    crumbs.push({
      label: known ?? decodeURIComponent(segment),
      href,
      truncate: !known,
    });
  }

  return crumbs;
}

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const crumbs = buildCrumbs(pathname);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <header className="border-border bg-background/70 sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b pr-3 pl-14 backdrop-blur-xl md:px-6">
      {/* Crumbs are links, not spans — the old version rendered dead text and
          leaked raw project ids into the trail. */}
      <nav aria-label="Percorso" className="min-w-0">
        <ol className="flex items-center gap-1.5 text-sm">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={crumb.href} className="flex min-w-0 items-center gap-1.5">
                {i > 0 && (
                  <span className="text-muted/50" aria-hidden>
                    /
                  </span>
                )}
                {last ? (
                  <span
                    className="text-foreground max-w-[16ch] truncate font-medium sm:max-w-[28ch]"
                    aria-current="page"
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <Link
                    href={crumb.href}
                    className="text-muted hover:text-foreground max-w-[12ch] truncate transition-colors"
                  >
                    {crumb.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <Button variant="ghost" size="sm" onPress={handleLogout}>
        <Icon icon="solar:logout-2-linear" width={16} aria-hidden />
        <span className="hidden sm:inline">Esci</span>
      </Button>
    </header>
  );
}
