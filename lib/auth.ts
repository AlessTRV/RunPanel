import crypto from "crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";

import { getSetting, setSetting, setSettingIfAbsent } from "./settings";
import { getDb, rowCount } from "./db";
import { generateId } from "./utils";

export const SESSION_COOKIE = "runpanel_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/** Only the hash is stored, so a database copy cannot be replayed as a cookie. */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// --- Password ---

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// --- Session ---

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Sessions are rows, not a singleton.
 *
 * The panel previously kept one `session_token` in the settings table, so
 * signing in anywhere signed you out everywhere else, and there was no way to
 * revoke one device without revoking all of them.
 */
export async function createSession(meta: { userAgent?: string; ip?: string } = {}): Promise<string> {
  const token = generateToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE * 1000).toISOString();

  const db = await getDb();
  await db
    .insertInto("sessions")
    .values({
      id: generateId(),
      token_hash: hashToken(token),
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
 * Whether a cookie value names a live session, without recording a visit.
 *
 * Split out for `proxy.ts`, which runs before the route handlers and has a
 * `NextRequest` rather than the `cookies()` store. Leaving `last_seen_at` alone
 * keeps the write on the request path it was already on, instead of doubling it.
 */
export async function isSessionTokenValid(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;

  try {
    const db = await getDb();
    const session = await db
      .selectFrom("sessions")
      .select(["id", "expires_at"])
      .where("token_hash", "=", hashToken(token))
      .executeTakeFirst();

    if (!session) return false;
    if (new Date(session.expires_at) < new Date()) {
      await db.deleteFrom("sessions").where("id", "=", session.id).execute();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function getSession(): Promise<boolean> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    if (!token) return false;

    // Looked up by hash, so the comparison happens inside an indexed equality
    // check rather than against a secret held in application memory.
    const db = await getDb();
    const session = await db
      .selectFrom("sessions")
      .select(["id", "expires_at", "last_seen_at"])
      .where("token_hash", "=", hashToken(token))
      .executeTakeFirst();

    if (!session) return false;

    if (new Date(session.expires_at) < new Date()) {
      await db.deleteFrom("sessions").where("id", "=", session.id).execute();
      return false;
    }

    // Throttled: without this every request would write a row.
    if (Date.now() - new Date(session.last_seen_at).getTime() > 60_000) {
      await db
        .updateTable("sessions")
        .set({ last_seen_at: new Date().toISOString() })
        .where("id", "=", session.id)
        .execute();
    }

    return true;
  } catch {
    return false;
  }
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    const db = await getDb();
    await db.deleteFrom("sessions").where("token_hash", "=", hashToken(token)).execute();
  }

  cookieStore.delete(SESSION_COOKIE);
}

/** Sign out every device. Used after a password change. */
export async function destroyAllSessions(): Promise<number> {
  const db = await getDb();
  const result = await db.deleteFrom("sessions").executeTakeFirst();
  return rowCount(result);
}

export async function listSessions() {
  const db = await getDb();
  return db
    .selectFrom("sessions")
    .select(["id", "user_agent", "ip", "created_at", "last_seen_at", "expires_at"])
    .orderBy("last_seen_at", "desc")
    .execute();
}

// --- Admin password ---

export async function getAdminPasswordHash(): Promise<string | null> {
  return getSetting("admin_password_hash");
}

export async function setAdminPassword(password: string): Promise<void> {
  const hash = await hashPassword(password);
  await setSetting("admin_password_hash", hash);
}

/**
 * Set the admin password only if there is not one already.
 *
 * First-run setup used to read `isFirstRun()` and then write, which two
 * concurrent requests could both pass. Returns false when someone else got
 * there first, so the caller can refuse instead of silently overwriting the
 * password the real operator just chose.
 */
export async function claimAdminPassword(password: string): Promise<boolean> {
  const hash = await hashPassword(password);
  return setSettingIfAbsent("admin_password_hash", hash);
}

export async function isFirstRun(): Promise<boolean> {
  return (await getAdminPasswordHash()) === null;
}

