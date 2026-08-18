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

/**
 * Which block of the sidebar an item sits in.
 *
 * `main` is the single unlabelled entry at the top, `footer` is pinned to the
 * bottom of the rail past a rule. The two in between carry a heading.
 */
export type NavGroupId = "main" | "infra" | "system" | "footer";

export interface NavItem {
  label: string;
  href: string;
  /** Iconify name. A literal, because the icon bundler greps for these. */
  icon: string;
  /**
   * The filled counterpart, shown while the destination is active. Also a
   * literal, and for the same reason.
   */
  iconActive: string;
  /**
   * Deliberately not optional. An item with no group would type-check and then
   * silently fail to render, which is the one failure mode this file exists to
   * prevent.
   */
  group: NavGroupId;
  /** Extra path prefixes that also light this item up. */
  owns?: string[];
  /** Shortcut hint shown in the command palette. */
  keys?: string;
}

/**
 * Ordered so the flat list reads the same as the grouped rail. The command
 * palette aliases this array directly, so the two stay in step for free.
 */
export const NAV_ITEMS: NavItem[] = [
  {
    label: "Panoramica",
    href: "/home",
    icon: "solar:widget-2-linear",
    iconActive: "solar:widget-2-bold-duotone",
    group: "main",
  },
  {
    label: "Progetti",
    href: "/projects",
    icon: "solar:folder-linear",
    iconActive: "solar:folder-bold-duotone",
    group: "infra",
    keys: "g p",
  },
  {
    label: "Servizi",
    href: "/services",
    icon: "solar:database-linear",
    iconActive: "solar:database-bold-duotone",
    group: "infra",
    keys: "g s",
  },
  {
    label: "Storage",
    href: "/storage",
    icon: "solar:ssd-square-linear",
    iconActive: "solar:ssd-square-bold-duotone",
    group: "infra",
  },
  {
    label: "Backup",
    href: "/backups",
    icon: "solar:archive-linear",
    iconActive: "solar:archive-bold-duotone",
    group: "infra",
    keys: "g b",
  },
  {
    label: "Monitor",
    href: "/monitor",
    icon: "solar:chart-2-linear",
    iconActive: "solar:chart-2-bold-duotone",
    group: "system",
  },
  {
    label: "Avvio automatico",
    href: "/autostart",
    icon: "solar:power-linear",
    iconActive: "solar:power-bold-duotone",
    group: "system",
  },
  {
    label: "Aggiornamenti",
    href: "/updates",
    icon: "solar:refresh-circle-linear",
    iconActive: "solar:refresh-circle-bold-duotone",
    group: "system",
  },
  {
    label: "Diagnostica",
    href: "/diagnostics",
    icon: "solar:health-linear",
    iconActive: "solar:health-bold-duotone",
    group: "system",
  },
  {
    label: "GitHub",
    href: "/github",
    icon: "solar:code-linear",
    iconActive: "solar:code-bold-duotone",
    group: "footer",
  },
  {
    label: "Impostazioni",
    href: "/account",
    icon: "solar:settings-linear",
    iconActive: "solar:settings-bold-duotone",
    group: "footer",
    owns: ["/settings"],
  },
];

/**
 * The labelled blocks, in the order they are drawn. `footer` is absent on
 * purpose: it is pinned outside the scrolling list, so the sidebar reaches for
 * it separately rather than mapping over it here.
 */
export const NAV_GROUPS: { id: NavGroupId; label?: string }[] = [
  { id: "main" },
  { id: "infra", label: "Infrastruttura" },
  { id: "system", label: "Sistema" },
];

export const navItemsIn = (group: NavGroupId): NavItem[] =>
  NAV_ITEMS.filter((item) => item.group === group);

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
