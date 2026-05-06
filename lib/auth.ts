import crypto from "crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { getDb } from "./db";
import { getSecret } from "./config";

const SESSION_COOKIE = "runpanel_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

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

export async function createSession(): Promise<string> {
  const db = getDb();
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();

  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
  ).run("session_token", token);
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
  ).run("session_expires", expiresAt);

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

    const db = getDb();
    const stored = db.prepare(
      "SELECT value FROM settings WHERE key = 'session_token'"
    ).get() as { value: string } | undefined;

    if (!stored || stored.value !== token) return false;

    const expires = db.prepare(
      "SELECT value FROM settings WHERE key = 'session_expires'"
    ).get() as { value: string } | undefined;

    if (!expires || new Date(expires.value) < new Date()) return false;

    return true;
  } catch {
    return false;
  }
}

export async function destroySession(): Promise<void> {
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key IN ('session_token', 'session_expires')").run();

  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

// --- Admin password ---

export function getAdminPasswordHash(): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT value FROM settings WHERE key = 'admin_password_hash'"
  ).get() as { value: string } | undefined;
  return row?.value ?? null;
}

export async function setAdminPassword(password: string): Promise<void> {
  const db = getDb();
  const hash = await hashPassword(password);
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
  ).run("admin_password_hash", hash);
}

export function isFirstRun(): boolean {
  return getAdminPasswordHash() === null;
}

// --- Encryption (for env vars) ---

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
  return decipher.update(encrypted) + decipher.final("utf8");
}
