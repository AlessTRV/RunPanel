import type { NextRequest } from "next/server";

import { getDb, nowIso } from "./db";
import { generateId } from "./utils";
import { getSetting } from "./settings";
import { trustedClientIp } from "./client-ip";
import {
  AUDIT_CATEGORIES_SETTING,
  AUDIT_RETENTION_SETTING,
  canSeeEntry,
  parseEnabledCategories,
  parseRetentionDays,
  retentionCutoff,
  shouldRecord,
  type AuditCategory,
  type AuditScope,
} from "./audit-filter";
import type { Principal } from "./authz";
import { visibleFolderIds, visibleProjectIds, visibleServiceIds } from "./principal";
import { getSession } from "./auth";

/**
 * The activity log: who did what, and when.
 *
 * Writing never fails the action it describes — a full disk or a locked table
 * should cost a line of history, not the deploy the operator asked for. The
 * rules (categories, visibility, retention) are in `lib/audit-filter.ts`.
 */

export interface AuditInput {
  /** Null when the panel acted by itself: scheduler, poll, webhook. */
  userId: string | null;
  category: AuditCategory;
  /** A short machine name, e.g. `project.deploy`, `user.invite`. */
  action: string;
  scope?: AuditScope | null;
  scopeId?: string | null;
  /** Names and keys only — never a secret value. */
  detail?: string | null;
  request?: NextRequest | null;
}

export async function audit(entry: AuditInput): Promise<void> {
  try {
    if (!shouldRecord(entry.category, parseEnabledCategories(await getSetting(AUDIT_CATEGORIES_SETTING)))) return;
    const db = await getDb();
    await db
      .insertInto("audit_log")
      .values({
        id: generateId(),
        at: nowIso(),
        user_id: entry.userId,
        category: entry.category,
        action: entry.action.slice(0, 64),
        scope: entry.scope ?? null,
        scope_id: entry.scopeId ?? null,
        detail: entry.detail?.slice(0, 500) ?? null,
        ip: entry.request ? trustedClientIp(entry.request)?.slice(0, 64) ?? null : null,
      })
      .execute();
  } catch (err) {
    console.error("[audit] Could not record:", err instanceof Error ? err.message : err);
  }
}

/** Entries older than the configured retention. Run by the housekeeping timer. */
export async function pruneAudit(now: Date = new Date()): Promise<number> {
  const days = parseRetentionDays(await getSetting(AUDIT_RETENTION_SETTING));
  const db = await getDb();
  const rows = await db.deleteFrom("audit_log").where("at", "<", retentionCutoff(days, now)).returning("id").execute();
  return rows.length;
}

export interface AuditQuery {
  userId?: string;
  category?: AuditCategory;
  action?: string;
  scope?: AuditScope;
  scopeId?: string;
  from?: string;
  to?: string;
  /** ISO time of the last entry already shown; the page continues before it. */
  before?: string;
  limit: number;
}

/**
 * A page of entries this principal may read, newest first.
 *
 * Visibility is decided per entry, so for anyone but the owner the query reads
 * ahead in batches and filters until the page is full or the table runs out.
 */
export async function queryAudit(principal: Principal, q: AuditQuery) {
  const db = await getDb();
  const visible = principal.isOwner
    ? null
    : {
        projects: await visibleProjectIds(principal),
        services: await visibleServiceIds(principal),
        folders: await visibleFolderIds(principal),
      };

  const out: Array<{
    id: string;
    at: string;
    userId: string | null;
    email: string | null;
    category: string;
    action: string;
    scope: string | null;
    scopeId: string | null;
    detail: string | null;
    ip: string | null;
  }> = [];
  let cursor = q.before ?? null;
  const batch = Math.max(q.limit * 2, 100);

  for (let round = 0; round < 20 && out.length < q.limit; round++) {
    let query = db
      .selectFrom("audit_log")
      .leftJoin("users", "users.id", "audit_log.user_id")
      .select([
        "audit_log.id",
        "audit_log.at",
        "audit_log.user_id",
        "users.email",
        "audit_log.category",
        "audit_log.action",
        "audit_log.scope",
        "audit_log.scope_id",
        "audit_log.detail",
        "audit_log.ip",
      ])
      .orderBy("audit_log.at", "desc")
      .limit(batch);
    if (q.userId) query = query.where("audit_log.user_id", "=", q.userId);
    if (q.category) query = query.where("audit_log.category", "=", q.category);
    if (q.action) query = query.where("audit_log.action", "=", q.action);
    if (q.scope) query = query.where("audit_log.scope", "=", q.scope);
    if (q.scopeId) query = query.where("audit_log.scope_id", "=", q.scopeId);
    if (q.from) query = query.where("audit_log.at", ">=", q.from);
    if (q.to) query = query.where("audit_log.at", "<=", q.to);
    if (cursor) query = query.where("audit_log.at", "<", cursor);

    const rows = await query.execute();
    for (const row of rows) {
      const entry = { category: row.category, scope: row.scope, scopeId: row.scope_id };
      if (visible && !canSeeEntry(principal, entry, visible)) continue;
      out.push({
        id: row.id,
        at: row.at,
        userId: row.user_id,
        email: row.email ?? null,
        category: row.category,
        action: row.action,
        scope: row.scope,
        scopeId: row.scope_id,
        detail: row.detail,
        ip: row.ip,
      });
      if (out.length >= q.limit) break;
    }
    if (rows.length < batch) break;
    cursor = rows[rows.length - 1].at;
  }

  // Names instead of ids, for what still exists; a deleted target keeps its id.
  const names = await targetNames(out);
  return {
    entries: out.map((e) => ({ ...e, scopeName: e.scope && e.scopeId ? names.get(`${e.scope}:${e.scopeId}`) ?? null : null })),
    nextBefore: out.length >= q.limit ? out[out.length - 1].at : null,
  };
}

async function targetNames(entries: ReadonlyArray<{ scope: string | null; scopeId: string | null }>) {
  const ids = (scope: string) => [...new Set(entries.filter((e) => e.scope === scope && e.scopeId).map((e) => e.scopeId!))];
  const db = await getDb();
  const names = new Map<string, string>();
  const users = ids("user");
  if (users.length) {
    for (const u of await db.selectFrom("users").select(["id", "email"]).where("id", "in", users).execute()) {
      if (u.email) names.set(`user:${u.id}`, u.email);
    }
  }
  const projects = ids("project");
  if (projects.length) {
    for (const p of await db.selectFrom("projects").select(["id", "name"]).where("id", "in", projects).execute()) {
      names.set(`project:${p.id}`, p.name);
    }
  }
  const services = ids("service");
  if (services.length) {
    for (const s of await db.selectFrom("services").select(["id", "name", "display_name"]).where("id", "in", services).execute()) {
      names.set(`service:${s.id}`, s.display_name || s.name);
    }
  }
  const folders = ids("folder");
  if (folders.length) {
    for (const f of await db.selectFrom("folders").select(["id", "name"]).where("id", "in", folders).execute()) {
      names.set(`folder:${f.id}`, f.name);
    }
  }
  return names;
}

/**
 * Run a route handler's body and record it only if it succeeded.
 *
 * A refused or failed request is not something that happened to a project,
 * and logging the attempt would put "deployed" next to a deploy that never
 * started. `scopeId` is resolved lazily from the route params.
 */
export async function withAudit(
  request: NextRequest,
  meta: {
    category: AuditCategory;
    action: string;
    scope?: AuditScope | null;
    scopeId?: string | null | (() => Promise<string | null>);
  },
  run: () => Promise<Response>
): Promise<Response> {
  const response = await run();
  if (response.status < 400) {
    const session = await getSession();
    const scopeId = typeof meta.scopeId === "function" ? await meta.scopeId() : meta.scopeId ?? null;
    await audit({
      userId: session?.user.id ?? null,
      category: meta.category,
      action: meta.action,
      scope: meta.scope ?? null,
      scopeId,
      request,
    });
  }
  return response;
}
