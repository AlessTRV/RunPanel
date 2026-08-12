import crypto from "crypto";
import { getSecret } from "./config";

/**
 * Encryption at rest for the secrets the panel stores on the operator's behalf:
 * project environment variables, service credentials, registry logins, the
 * GitHub token.
 *
 * Lived in `lib/auth.ts` until a migration needed to read an encrypted value.
 * It could not: `lib/auth.ts` imports `next/headers` and the database, and the
 * database module is what runs migrations — so importing it from one closed a
 * cycle. Nothing about AES-GCM belongs to sessions and passwords anyway; the
 * two only shared a file.
 *
 * Depends on `getSecret()` and `node:crypto` and nothing else, which is what
 * makes it safe to import from anywhere, migrations included.
 */

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

/**
 * Decrypt a value that may not be decryptable.
 *
 * A ciphertext written under a different `RUNPANEL_SECRET` — a restored backup,
 * a rotated key — throws on the authentication tag. Callers that are reading
 * many rows to make a decision, rather than serving one value to a user, want
 * to carry on rather than fail the whole pass.
 */
export function tryDecrypt(encoded: string): string | null {
  try {
    return decrypt(encoded);
  } catch {
    return null;
  }
}
