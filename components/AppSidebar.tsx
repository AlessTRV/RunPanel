"use client";

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
  { label: "Projects", href: "/projects", icon: "solar:box-bold-duotone" },
  { label: "Services", href: "/services", icon: "solar:database-bold-duotone" },
  { label: "Monitoring", href: "/monitoring", icon: "solar:chart-bold-duotone" },
  { label: "Settings", href: "/settings", icon: "solar:settings-bold-duotone" },
];

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-64 flex-col border-r border-divider bg-content1">
      <div className="flex h-16 items-center gap-3 border-b border-divider px-6">
        <Icon icon="solar:server-bold-duotone" className="text-primary" width={28} />
        <span className="text-xl font-bold">RunPanel</span>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-foreground-500 hover:bg-default-100 hover:text-foreground"
              )}
            >
              <Icon icon={item.icon} width={22} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-divider p-4">
        <div className="flex items-center gap-2 text-xs text-foreground-400">
          <Chip size="sm" variant="soft">v0.1.0</Chip>
          <span>RunPanel</span>
        </div>
      </div>
    </aside>
  );
}
