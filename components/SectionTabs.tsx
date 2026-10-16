"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { NAV_SECTIONS, isActiveNav, type NavSectionId } from "@/lib/nav";
import { useAllowedNav } from "@/lib/hooks/useMe";
import { useServerHref } from "@/lib/hooks/useNode";

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
  const href = useServerHref();
  const allowed = useAllowedNav();
  const { label, tabs } = NAV_SECTIONS[section];
  const visible = tabs.filter(allowed);

  if (visible.length < 2) return null;

  return (
    // The baseline is an inset shadow, not a border: with overflow-x-auto the
    // strip also scrolls vertically, so a tab pulled 1px over a border with
    // -mb-px drew a stray vertical scrollbar. The tab's own border covers it.
    <nav
      aria-label={label}
      className="mb-6 flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-border)]"
    >
      {visible.map((tab) => {
        const active = isActiveNav(pathname, tab);
        return (
          <Link
            key={tab.href}
            href={href(tab.href)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors",
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
