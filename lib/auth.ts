import crypto from "crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";

import { getDb, rowCount } from "./db";
import { generateId } from "./utils";
import { authzEvents } from "@/services/events";

export const SESSION_COOKIE = "runpanel_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/** Only the hash is stored, so a database copy cannot be replayed as a cookie. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// --- Password ---

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Compared against when no account matched, so a wrong email costs the same
 * bcrypt round as a wrong password and response time does not say which
 * addresses exist.
 */
const DUMMY_HASH = bcrypt.hashSync("runpanel-no-such-user", 12);

export async function verifyPasswordOrDummy(password: string, hash: string | null): Promise<boolean> {
  const ok = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  return ok && hash !== null;
}

// --- Session ---

export interface SessionUser {
  id: string;
  /** Null only for the owner migrated from the single password, until they set one. */
  email: string | null;
  isOwner: boolean;
}

export interface SessionInfo {
  sessionId: string;
  user: SessionUser;
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Sessions are rows, not a singleton.
 *
 * The panel previously kept one `session_token` in the settings table, so
 * signing in anywhere signed you out everywhere else, and there was no way to
 * revoke one device without revoking all of them. Each row now belongs to a
 * user (migration 023).
 */
export async function createSession(userId: string, meta: { userAgent?: string; ip?: string } = {}): Promise<string> {
  const token = generateToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE * 1000).toISOString();

  const db = await getDb();
  await db
    .insertInto("sessions")
    .values({
      id: generateId(),
      token_hash: hashToken(token),
      user_id: userId,
      user_agent: meta.userAgent?.slice(0, 255) ?? null,
      ip: meta.ip?.slice(0, 64) ?? null,
      created_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      expires_at: expiresAt,
    })
    .execute();

  // Opportunistic tidy-up: expired rows have no other reaper.
  await db.deleteFrom("sessions").where("expires_at", "<", now.toISOString()).execute();

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });

  return token;
}

/**
 * The session a cookie value names, with its user, or null.
 *
 * A session of a disabled account, or one no account owns (a row from before
 * migration 023 on a store that had no password yet), is not a session.
 */
async function lookupSession(token: string, touch: boolean): Promise<SessionInfo | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select([
      "sessions.id as session_id",
      "sessions.expires_at",
      "sessions.last_seen_at",
      "users.id as user_id",
      "users.email",
      "users.is_owner",
      "users.disabled",
    ])
    .where("sessions.token_hash", "=", hashToken(token))
    .executeTakeFirst();

  if (!row || row.disabled === 1) return null;

  if (new Date(row.expires_at) < new Date()) {
    await db.deleteFrom("sessions").where("id", "=", row.session_id).execute();
    return null;
  }

  // Throttled: without this every request would write a row.
  if (touch && Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    await db
      .updateTable("sessions")
      .set({ last_seen_at: new Date().toISOString() })
      .where("id", "=", row.session_id)
      .execute();
  }

  return {
    sessionId: row.session_id,
    user: { id: row.user_id, email: row.email, isOwner: row.is_owner === 1 },
  };
}

/**
 * Whether a cookie value names a live session, without recording a visit.
 *
 * Split out for `proxy.ts`, which runs before the route handlers and has a
 * `NextRequest` rather than the `cookies()` store. Leaving `last_seen_at` alone
 * keeps the write on the request path it was already on, instead of doubling it.
 */
export async function isSessionTokenValid(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  try {
    return (await lookupSession(token, false)) !== null;
  } catch {
    return false;
  }
}

export async function getSession(): Promise<SessionInfo | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return await lookupSession(token, true);
  } catch {
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    const db = await getDb();
    const row = await db
      .deleteFrom("sessions")
      .where("token_hash", "=", hashToken(token))
      .returning(["id", "user_id"])
      .executeTakeFirst();
    if (row?.user_id) authzEvents.emit(row.user_id, { type: "session-revoked", sessionId: row.id });
  }

  cookieStore.delete(SESSION_COOKIE);
}

/** Revoke one session by id. Returns whose it was, or null if there was none. */
export async function revokeSession(sessionId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db
    .deleteFrom("sessions")
    .where("id", "=", sessionId)
    .returning(["id", "user_id"])
    .executeTakeFirst();
  if (!row) return null;
  if (row.user_id) authzEvents.emit(row.user_id, { type: "session-revoked", sessionId: row.id });
  return row.user_id ?? null;
}

/**
 * Sign a user out everywhere, except optionally the session doing it. Used
 * after a password change, a reset, or when an account is disabled.
 */
export async function destroyUserSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const db = await getDb();
  let query = db.deleteFrom("sessions").where("user_id", "=", userId);
  if (exceptSessionId) query = query.where("id", "!=", exceptSessionId);
  const result = await query.executeTakeFirst();
  authzEvents.emit(userId, { type: "user-changed" });
  return rowCount(result);
}

/** Sessions of one user, or of everyone when `userId` is omitted. */
export async function listSessions(userId?: string) {
  const db = await getDb();
  let query = db
    .selectFrom("sessions")
    .leftJoin("users", "users.id", "sessions.user_id")
    .select([
      "sessions.id",
      "sessions.user_id",
      "users.email",
      "sessions.user_agent",
      "sessions.ip",
      "sessions.created_at",
      "sessions.last_seen_at",
      "sessions.expires_at",
    ])
    .orderBy("sessions.last_seen_at", "desc");
  if (userId) query = query.where("sessions.user_id", "=", userId);
  return query.execute();
}

// --- First run ---

/** No owner yet: the setup form is what the login page shows. */
export async function isFirstRun(): Promise<boolean> {
  const db = await getDb();
  const owner = await db.selectFrom("users").select("id").where("is_owner", "=", 1).executeTakeFirst();
  return owner === undefined;
}
