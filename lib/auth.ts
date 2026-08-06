import crypto from "crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { getSecret } from "./config";
import { getSetting, setSetting } from "./settings";
import { getDb, rowCount } from "./db";
import { generateId } from "./utils";

const SESSION_COOKIE = "runpanel_session";
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

export async function isFirstRun(): Promise<boolean> {
  return (await getAdminPasswordHash()) === null;
}

// --- Encryption (for env vars and service credentials) ---

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encrypt(text: string): string {
  const key = Buffer.from(getSecret(), "hex").subarray(0, 32);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(encoded: string): string {
  const key = Buffer.from(getSecret(), "hex").subarray(0, 32);
  const data = Buffer.from(encoded, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // Concat as bytes, decode once: decoding each chunk separately corrupts any
  // multi-byte character that straddles the update/final boundary.
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
