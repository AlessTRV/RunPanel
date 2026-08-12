/**
 * The panel's destinations, in one list.
 *
 * They were written out three times — the sidebar, the command palette, and the
 * breadcrumb's segment map — and the copies had already drifted: "Avvio" in one,
 * "Avvio automatico" in another, and "Overview" left in English in all three.
 * That last one is why this file exists: an English word in an Italian panel is
 * a small thing, but it was on every single screen, and fixing it meant editing
 * three files and hoping there was not a fourth.
 *
 * `label` is Italian. `slug` names are English because they are URLs, and a URL
 * is an identifier rather than something the reader is meant to read.
 */

export interface NavItem {
  label: string;
  href: string;
  /** Iconify name. A literal, because the icon bundler greps for these. */
  icon: string;
  /** Extra path prefixes that also light this item up. */
  owns?: string[];
  /** Shortcut hint shown in the command palette. */
  keys?: string;
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Panoramica", href: "/home", icon: "solar:widget-2-linear" },
  { label: "Progetti", href: "/projects", icon: "solar:folder-linear", keys: "g p" },
  { label: "Servizi", href: "/services", icon: "solar:database-linear", keys: "g s" },
  { label: "Monitor", href: "/monitor", icon: "solar:chart-2-linear" },
  { label: "Storage", href: "/storage", icon: "solar:ssd-square-linear" },
  { label: "Backup", href: "/backups", icon: "solar:archive-linear", keys: "g b" },
  { label: "Avvio automatico", href: "/autostart", icon: "solar:power-linear" },
  { label: "Diagnostica", href: "/diagnostics", icon: "solar:health-linear" },
  { label: "GitHub", href: "/github", icon: "solar:code-linear" },
  { label: "Impostazioni", href: "/account", icon: "solar:settings-linear", owns: ["/settings"] },
];

/**
 * Breadcrumb labels, derived from the same list plus the segments that are not
 * destinations of their own — a run id's parent, a wizard step.
 */
export const SEGMENT_LABELS: Record<string, string> = {
  ...Object.fromEntries(NAV_ITEMS.map((item) => [item.href.replace(/^\//, ""), item.label])),
  settings: "Impostazioni",
  policies: "Pianificazioni",
  runs: "Esecuzioni",
  restore: "Ripristino",
  new: "Nuovo",
};

export function isActiveNav(pathname: string, item: NavItem): boolean {
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return (item.owns ?? []).some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
