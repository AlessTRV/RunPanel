import crypto from "crypto";

import { getDb, nowIso } from "./db";
import { generateId } from "./utils";
import { destroyUserSessions, hashPassword, hashToken } from "./auth";
import { GLOBAL_PERMISSIONS, normalizeGrants, type Grant, type GlobalPermission } from "./authz";
import { authzEvents } from "@/services/events";
import type { UsersTable } from "./db/schema";

/**
 * Accounts, invitations and access rows — the writes behind the users pages.
 *
 * The decision of who may do what is `lib/authz.ts`; this module only stores
 * it. Every write that changes what a user can reach emits `user-changed`, so
 * an open stream or shell of theirs re-checks instead of outliving the grant.
 */

export type UserRow = UsersTable;

/** Invitation links: the operator picks the lifetime, within these bounds. */
export const INVITE_MIN_HOURS = 1;
export const INVITE_MAX_HOURS = 24 * 30;
export const INVITE_DEFAULT_HOURS = 48;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lower-cased and trimmed, or null when it is not an address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

function changed(userId: string): void {
  authzEvents.emit(userId, { type: "user-changed" });
}

/**
 * Create the owner, unless one exists. Returns its id, or null when someone
 * else got there first — the partial unique index on `is_owner` makes the
 * insert itself the claim, so two racing setups cannot both win.
 */
export async function claimOwner(email: string, password: string): Promise<string | null> {
  const db = await getDb();
  const id = generateId();
  try {
    await db
      .insertInto("users")
      .values({
        id,
        email,
        password_hash: await hashPassword(password),
        is_owner: 1,
        disabled: 0,
        created_by: null,
        created_at: nowIso(),
        last_login_at: null,
      })
      .execute();
    return id;
  } catch {
    return null;
  }
}

/**
 * The account a login form names. An empty email only ever finds the owner
 * migrated from the single password, and only while they have no email yet.
 */
export async function findLoginUser(email: string | null): Promise<UserRow | null> {
  const db = await getDb();
  const row = email
    ? await db.selectFrom("users").selectAll().where("email", "=", email).executeTakeFirst()
    : await db
        .selectFrom("users")
        .selectAll()
        .where("is_owner", "=", 1)
        .where("email", "is", null)
        .executeTakeFirst();
  return row ?? null;
}

export async function getUser(userId: string): Promise<UserRow | null> {
  const db = await getDb();
  return (await db.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst()) ?? null;
}

export async function recordLogin(userId: string): Promise<void> {
  const db = await getDb();
  await db.updateTable("users").set({ last_login_at: nowIso() }).where("id", "=", userId).execute();
}

/** A new account with no password and no access. Null when the email is taken. */
export async function createInvitedUser(email: string, createdBy: string): Promise<UserRow | null> {
  const db = await getDb();
  const row: UserRow = {
    id: generateId(),
    email,
    password_hash: null,
    is_owner: 0,
    disabled: 0,
    created_by: createdBy,
    created_at: nowIso(),
    last_login_at: null,
  };
  try {
    await db.insertInto("users").values(row).execute();
    return row;
  } catch {
    return null;
  }
}

export function clampInviteHours(raw: unknown): number | null {
  const hours = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(hours)) return null;
  const whole = Math.round(hours);
  if (whole < INVITE_MIN_HOURS || whole > INVITE_MAX_HOURS) return null;
  return whole;
}

/**
 * A one-time link token for a first password or a reset. Only its hash is
 * stored; issuing a new one voids every unused link of that user, so a link
 * sent to the wrong place can be killed by sending a fresh one.
 */
export async function issueInvite(
  userId: string,
  kind: "invite" | "reset",
  hours: number,
  createdBy: string
): Promise<{ token: string; expiresAt: string }> {
  const db = await getDb();
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + hours * 3_600_000).toISOString();

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("user_invites").where("user_id", "=", userId).where("used_at", "is", null).execute();
    await trx
      .insertInto("user_invites")
      .values({
        id: generateId(),
        user_id: userId,
        token_hash: hashToken(token),
        kind,
        expires_at: expiresAt,
        used_at: null,
        created_by: createdBy,
        created_at: now.toISOString(),
      })
      .execute();
  });

  return { token, expiresAt };
}

/** What a link is for, or null when it is unknown, used, expired or its user disabled. */
export async function inspectInvite(token: unknown): Promise<{ userId: string; email: string; kind: "invite" | "reset" } | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 128) return null;
  const db = await getDb();
  const row = await db
    .selectFrom("user_invites")
    .innerJoin("users", "users.id", "user_invites.user_id")
    .select(["user_invites.user_id", "user_invites.kind", "user_invites.expires_at", "user_invites.used_at", "users.email", "users.disabled"])
    .where("user_invites.token_hash", "=", hashToken(token))
    .executeTakeFirst();
  if (!row || row.used_at || row.disabled === 1 || !row.email) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return { userId: row.user_id, email: row.email, kind: row.kind === "reset" ? "reset" : "invite" };
}

/**
 * Spend a link: set the password, mark it used, sign the user out elsewhere.
 * The `used_at IS NULL` condition on the update is the claim, so a link opened
 * twice at once is spent once.
 */
export async function redeemInvite(token: string, password: string): Promise<string | null> {
  const invite = await inspectInvite(token);
  if (!invite) return null;

  const db = await getDb();
  const passwordHash = await hashPassword(password);
  const claimed = await db
    .updateTable("user_invites")
    .set({ used_at: nowIso() })
    .where("token_hash", "=", hashToken(token))
    .where("used_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!claimed) return null;

  await db.updateTable("users").set({ password_hash: passwordHash }).where("id", "=", invite.userId).execute();
  await destroyUserSessions(invite.userId);
  return invite.userId;
}

export async function setUserDisabled(userId: string, disabled: boolean): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("users")
    .set({ disabled: disabled ? 1 : 0 })
    .where("id", "=", userId)
    .where("is_owner", "=", 0)
    .execute();
  if (disabled) await destroyUserSessions(userId);
  else changed(userId);
}

export async function deleteUser(userId: string): Promise<void> {
  const db = await getDb();
  await db.deleteFrom("users").where("id", "=", userId).where("is_owner", "=", 0).execute();
  // After the delete: a recheck that ran first would still find the account.
  changed(userId);
}

/**
 * Inherited access moved — a project changed folder, a service was linked or
 * unlinked — so whoever reached it through a folder or a project may have
 * gained or lost it. Cheap: one event per account, and only open streams and
 * shells listen.
 */
export async function accessChangedForEveryone(): Promise<void> {
  const db = await getDb();
  const rows = await db.selectFrom("users").select("id").where("is_owner", "=", 0).execute();
  for (const row of rows) changed(row.id);
}

export interface UserAccess {
  permissions: GlobalPermission[];
  grants: Grant[];
}

export async function getUserAccess(userId: string): Promise<UserAccess> {
  const db = await getDb();
  const [perms, grants] = await Promise.all([
    db.selectFrom("user_permissions").select("permission").where("user_id", "=", userId).execute(),
    db.selectFrom("user_grants").select(["scope", "scope_id", "level", "terminal"]).where("user_id", "=", userId).execute(),
  ]);
  const known = new Set<string>(GLOBAL_PERMISSIONS);
  return {
    permissions: perms.map((p) => p.permission).filter((p): p is GlobalPermission => known.has(p)),
    grants: grants.map((g) => ({
      scope: g.scope as Grant["scope"],
      scopeId: g.scope === "all" ? null : g.scope_id,
      level: g.level as Grant["level"],
      terminal: g.terminal === 1,
    })),
  };
}

/** Replace a user's whole access in one transaction. */
export async function setUserAccess(userId: string, access: UserAccess): Promise<void> {
  const db = await getDb();
  const now = nowIso();
  const permissions = [...new Set(access.permissions)];
  const grants = normalizeGrants(access.grants);

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("user_permissions").where("user_id", "=", userId).execute();
    await trx.deleteFrom("user_grants").where("user_id", "=", userId).execute();
    if (permissions.length > 0) {
      await trx
        .insertInto("user_permissions")
        .values(permissions.map((permission) => ({ user_id: userId, permission })))
        .execute();
    }
    if (grants.length > 0) {
      await trx
        .insertInto("user_grants")
        .values(
          grants.map((g) => ({
            id: generateId(),
            user_id: userId,
            scope: g.scope,
            scope_id: g.scopeId ?? "",
            level: g.level,
            terminal: g.terminal ? 1 : 0,
            created_at: now,
          }))
        )
        .execute();
    }
  });
  changed(userId);
}

/**
 * Give the creator of a project or service `manage` on it, unless they already
 * reach it that way. Without this, a user allowed to create projects would
 * create one and then not be able to open it.
 */
export async function grantCreator(userId: string, scope: "project" | "service", targetId: string): Promise<void> {
  const db = await getDb();
  const user = await getUser(userId);
  if (!user || user.is_owner === 1) return;
  await db
    .insertInto("user_grants")
    .values({
      id: generateId(),
      user_id: userId,
      scope,
      scope_id: targetId,
      level: "manage",
      terminal: 0,
      created_at: nowIso(),
    })
    .onConflict((oc) => oc.columns(["user_id", "scope", "scope_id"]).doUpdateSet({ level: "manage" }))
    .execute();
  changed(userId);
}

/** Drop every grant pointing at something that is being deleted. */
export async function deleteGrantsFor(scope: "folder" | "project" | "service", targetId: string): Promise<void> {
  const db = await getDb();
  const rows = await db
    .deleteFrom("user_grants")
    .where("scope", "=", scope)
    .where("scope_id", "=", targetId)
    .returning("user_id")
    .execute();
  for (const userId of new Set(rows.map((r) => r.user_id))) changed(userId);
}

export async function setOwnEmail(userId: string, email: string): Promise<"ok" | "taken"> {
  const db = await getDb();
  const other = await db.selectFrom("users").select("id").where("email", "=", email).executeTakeFirst();
  if (other && other.id !== userId) return "taken";
  try {
    await db.updateTable("users").set({ email }).where("id", "=", userId).execute();
    return "ok";
  } catch {
    return "taken";
  }
}

export async function setOwnPassword(userId: string, password: string): Promise<void> {
  const db = await getDb();
  await db.updateTable("users").set({ password_hash: await hashPassword(password) }).where("id", "=", userId).execute();
}

export type UserStatus = "active" | "invited" | "invite_expired" | "disabled";

/** Every account with what the list page shows. */
export async function listUsers(): Promise<Array<{
  id: string;
  email: string | null;
  isOwner: boolean;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  inviteExpiresAt: string | null;
}>> {
  const db = await getDb();
  const [users, invites] = await Promise.all([
    db.selectFrom("users").selectAll().orderBy("created_at", "asc").execute(),
    db.selectFrom("user_invites").select(["user_id", "expires_at"]).where("used_at", "is", null).execute(),
  ]);
  const pending = new Map(invites.map((i) => [i.user_id, i.expires_at]));
  const now = Date.now();
  return users.map((u) => {
    const inviteExpiresAt = pending.get(u.id) ?? null;
    let status: UserStatus = "active";
    if (u.disabled === 1) status = "disabled";
    else if (!u.password_hash) status = inviteExpiresAt && new Date(inviteExpiresAt).getTime() > now ? "invited" : "invite_expired";
    return {
      id: u.id,
      email: u.email,
      isOwner: u.is_owner === 1,
      status,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
      inviteExpiresAt,
    };
  });
}
