"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { Chip } from "@heroui/react";
import { clsx } from "clsx";

interface NavItem {
  label: string;
  href: string;
  icon: string;
}

const navItems: NavItem[] = [
  { label: "Home", href: "/home", icon: "solar:home-bold-duotone" },
  { label: "Settings", href: "/settings", icon: "solar:settings-bold-duotone" },
];

export function AppSidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const sidebar = (
    <aside className={clsx(
      "fixed left-0 top-0 z-40 flex h-screen w-64 flex-col border-r border-purple-500/10 backdrop-blur-xl",
      "transition-transform duration-200",
      mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
    )} style={{ background: "linear-gradient(180deg, rgba(18,12,32,0.92) 0%, rgba(11,6,19,0.96) 100%)" }}>
      <div className="flex h-16 items-center gap-3 border-b border-purple-500/10 px-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/15">
          <Icon icon="solar:server-bold-duotone" className="text-purple-400" width={20} />
        </div>
        <span className="text-lg font-bold bg-gradient-to-r from-purple-200 to-purple-400 bg-clip-text text-transparent">RunPanel</span>
        <button className="ml-auto md:hidden text-foreground-400" onClick={() => setMobileOpen(false)}>
          <Icon icon="solar:close-circle-bold-duotone" width={22} />
        </button>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {navItems.map((item) => {
          const isActive = item.href === "/home"
            ? pathname === "/home" || pathname.startsWith("/projects") || pathname.startsWith("/services")
            : pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-purple-500/10 text-purple-300"
                  : "text-foreground-500 hover:bg-purple-500/5 hover:text-foreground"
              )}
            >
              <Icon icon={item.icon} width={22} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-purple-500/10 p-4">
        <div className="flex items-center gap-2 text-xs text-foreground-400">
          <Chip size="sm" variant="soft">v0.1.0</Chip>
          <span>RunPanel</span>
        </div>
      </div>
    </aside>
  );

  return (
    <>
      {/* Mobile hamburger */}
      <button
        className="fixed top-4 left-4 z-50 flex md:hidden h-10 w-10 items-center justify-center rounded-lg bg-black/50 backdrop-blur-xl border border-white/[0.07]"
        onClick={() => setMobileOpen(true)}
      >
        <Icon icon="solar:hamburger-menu-bold-duotone" width={20} className="text-foreground-300" />
      </button>

      {/* Backdrop */}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {sidebar}
    </>
  );
}
