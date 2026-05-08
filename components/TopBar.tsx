"use client";

import { usePathname, useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";

const breadcrumbMap: Record<string, string> = {
  "/home": "Home",
  "/projects": "Projects",
  "/services": "Services",
  "/monitor": "Monitor",
  "/github": "GitHub",
  "/account": "Account",
};

function getBreadcrumbs(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: { label: string; href: string }[] = [];

  let path = "";
  for (const segment of segments) {
    path += "/" + segment;
    let label = breadcrumbMap[path] || decodeURIComponent(segment);
    if (label.length > 12) label = label.slice(0, 8) + "\u2026";
    crumbs.push({ label, href: path });
  }

  return crumbs;
}

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const crumbs = getBreadcrumbs(pathname);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-purple-500/10 pl-14 pr-4 md:px-6 backdrop-blur-xl" style={{ background: "rgba(11,6,19,0.6)" }}>
      <div className="flex items-center gap-2 text-sm min-w-0 overflow-hidden">
        <Icon icon="solar:home-bold-duotone" className="text-foreground-400" width={18} />
        {crumbs.map((crumb, i) => (
          <span key={crumb.href} className="flex items-center gap-2">
            <span className="text-foreground-400">/</span>
            <span
              className={
                i === crumbs.length - 1
                  ? "font-medium text-foreground"
                  : "text-foreground-400"
              }
            >
              {crumb.label}
            </span>
          </span>
        ))}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onPress={handleLogout}
      >
        <Icon icon="solar:logout-2-bold-duotone" width={18} />
        Logout
      </Button>
    </header>
  );
}
