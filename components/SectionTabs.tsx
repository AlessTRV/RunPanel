"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { NAV_SECTIONS, isActiveNav, type NavSectionId } from "@/lib/nav";
import { useAllowedNav } from "@/lib/hooks/useMe";

/**
 * The tabs of a sidebar entry that stands for several pages.
 *
 * Links, not buttons: each tab is a page with its own URL, so back, reload and
 * a link pasted in chat all land on the right one. Drawn like `ui/Tabs` so a
 * tab looks the same whether it switches a page or a view inside one.
 *
 * Tabs the user may not open are left out; with one left there is nothing to
 * switch between, and the strip is not drawn at all.
 */
export function SectionTabs({ section }: { section: NavSectionId }) {
  const pathname = usePathname();
  const allowed = useAllowedNav();
  const { label, tabs } = NAV_SECTIONS[section];
  const visible = tabs.filter(allowed);

  if (visible.length < 2) return null;

  return (
    <nav aria-label={label} className="border-border mb-6 flex gap-1 overflow-x-auto border-b">
      {visible.map((tab) => {
        const active = isActiveNav(pathname, tab);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors",
              active
                ? "border-accent text-foreground font-medium"
                : "text-muted hover:text-foreground border-transparent"
            )}
          >
            <Icon
              icon={active ? tab.iconActive : tab.icon}
              width={15}
              aria-hidden
              className={cn(active && "text-accent")}
            />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
