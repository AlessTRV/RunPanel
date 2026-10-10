/**
 * The rules of the activity log, with no database and no Node imports, so
 * `tests/suites/audit-unit` can load them directly. The writes and queries
 * live in `lib/audit.ts`.
 */
import type { GlobalPermission, Principal } from "./authz";

export const AUDIT_CATEGORIES = ["security", "deploy", "config", "terminal", "backup", "system", "delete"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/**
 * What an entry is about. `permission` names a panel-wide area by the
 * permission that guards it (`scopeId` is e.g. `"backup"`), so whoever may use
 * the area may read its history.
 */
export type AuditScope = "project" | "service" | "folder" | "user" | "permission";

export const AUDIT_CATEGORIES_SETTING = "audit_categories";
export const AUDIT_RETENTION_SETTING = "audit_retention_days";
export const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 3650;

/**
 * The categories to record. Nothing stored, or something unreadable, means all
 * of them; `security` is in the set whatever was stored.
 */
export function parseEnabledCategories(raw: string | null): Set<AuditCategory> {
  const known = new Set<string>(AUDIT_CATEGORIES);
  let list: unknown = null;
  try {
    list = raw === null ? null : JSON.parse(raw);
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) return new Set(AUDIT_CATEGORIES);
  const enabled = new Set(list.filter((c): c is AuditCategory => typeof c === "string" && known.has(c)));
  enabled.add("security");
  return enabled;
}

export function shouldRecord(category: AuditCategory, enabled: ReadonlySet<AuditCategory>): boolean {
  return category === "security" || enabled.has(category);
}

export function parseRetentionDays(raw: string | null): number {
  const days = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(days)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(1, days));
}

export function retentionCutoff(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export interface AuditEntryRef {
  category: string;
  scope: string | null;
  scopeId: string | null;
}

export interface VisibleSets {
  projects: ReadonlySet<string> | "all";
  services: ReadonlySet<string> | "all";
  folders: ReadonlySet<string> | "all";
}

const has = (set: ReadonlySet<string> | "all", id: string | null) => set === "all" || (id !== null && set.has(id));

/**
 * Whether `principal` may read an entry. Holding `audit.view` is checked by
 * the route; this decides entry by entry. Security entries — sign-ins,
 * invitations, access changes — are about people, so they go with
 * `users.manage`. An entry about nothing in particular is the owner's.
 */
export function canSeeEntry(principal: Principal, entry: AuditEntryRef, visible: VisibleSets): boolean {
  if (principal.isOwner) return true;
  if (entry.category === "security" || entry.scope === "user") return principal.permissions.has("users.manage");
  switch (entry.scope) {
    case "project":
      return has(visible.projects, entry.scopeId);
    case "service":
      return has(visible.services, entry.scopeId);
    case "folder":
      return has(visible.folders, entry.scopeId);
    case "permission":
      return entry.scopeId !== null && principal.permissions.has(entry.scopeId as GlobalPermission);
    default:
      return false;
  }
}
