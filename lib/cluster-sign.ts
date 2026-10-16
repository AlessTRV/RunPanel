import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * How cluster members prove a request is theirs.
 *
 * Every call between two RunPanel installs carries an HMAC-SHA256 over the
 * method, path, query, a timestamp, the calling member's id, the user it acts
 * for and the SHA-256 of the body, keyed with the cluster secret. A request is
 * accepted only inside a ±5 minute window, so a captured request cannot be
 * replayed later, and the body hash means it cannot be re-pointed at another
 * resource either.
 *
 * The method and path travel in headers too: a route handler reaches its
 * request headers through `headers()` but not the request line, and the proxy
 * in front of it checks that those two headers match the real request.
 *
 * Zero imports beyond `node:crypto`, so a standalone suite can load it, and
 * `hashToken` repeats the formula in lib/auth.ts for the same reason.
 */

export const HDR_MEMBER = "x-runpanel-member";
export const HDR_TIMESTAMP = "x-runpanel-timestamp";
export const HDR_SIGNATURE = "x-runpanel-signature";
export const HDR_USER = "x-runpanel-user";
export const HDR_BODY = "x-runpanel-body-sha256";
export const HDR_METHOD = "x-runpanel-method";
export const HDR_PATH = "x-runpanel-path";

/** How far apart two members' clocks may be before a request is refused. */
export const SKEW_MS = 5 * 60_000;

export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Same formula as sessions and invites: what the store keeps of a token. */
export function hashToken(token: string): string {
  return sha256Hex(token);
}

export interface SignedRequestParts {
  method: string;
  /** Pathname only, e.g. `/api/cluster/ping`. */
  path: string;
  /** The query string including its `?`, or empty. */
  query: string;
  /** Milliseconds since the epoch, as sent in the header. */
  timestamp: string;
  memberId: string;
  /** The user the request acts for, or null for member-to-member calls. */
  userId: string | null;
  bodySha256: string;
}

export function canonicalRequest(p: SignedRequestParts): string {
  return ["v1", p.method.toUpperCase(), p.path, p.query, p.timestamp, p.memberId, p.userId ?? "", p.bodySha256].join("\n");
}

export function signRequest(secret: string, p: SignedRequestParts): string {
  return createHmac("sha256", secret).update(canonicalRequest(p)).digest("hex");
}

export type VerifyResult = { ok: true } | { ok: false; reason: "malformed" | "skew" | "signature" };

export function verifyRequest(secret: string, p: SignedRequestParts & { signature: string }, now = Date.now()): VerifyResult {
  const ts = Number(p.timestamp);
  if (!/^\d{10,16}$/.test(p.timestamp) || !Number.isFinite(ts)) return { ok: false, reason: "malformed" };
  if (!/^[0-9a-f]{64}$/.test(p.signature) || !/^[0-9a-f]{64}$/.test(p.bodySha256)) return { ok: false, reason: "malformed" };
  if (!p.memberId || !p.method || !p.path.startsWith("/")) return { ok: false, reason: "malformed" };
  if (Math.abs(now - ts) > SKEW_MS) return { ok: false, reason: "skew" };

  const expected = Buffer.from(signRequest(secret, p), "hex");
  const given = Buffer.from(p.signature, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "signature" };
  return { ok: true };
}

/**
 * The headers a signed request carries. The caller computes `bodySha256`
 * (`EMPTY_BODY_SHA256` when there is no body) and passes the same method and
 * path it will actually send.
 */
export function signedHeaders(
  secret: string,
  p: Omit<SignedRequestParts, "timestamp"> & { timestamp?: string }
): Record<string, string> {
  const timestamp = p.timestamp ?? String(Date.now());
  const parts: SignedRequestParts = { ...p, timestamp, method: p.method.toUpperCase() };
  const headers: Record<string, string> = {
    [HDR_MEMBER]: p.memberId,
    [HDR_TIMESTAMP]: timestamp,
    [HDR_BODY]: p.bodySha256,
    [HDR_METHOD]: parts.method,
    [HDR_PATH]: `${p.path}${p.query}`,
    [HDR_SIGNATURE]: signRequest(secret, parts),
  };
  if (p.userId) headers[HDR_USER] = p.userId;
  return headers;
}

/** Pull the signed parts back out of a request's headers. Null when the request is not signed at all. */
export function readSignedHeaders(get: (name: string) => string | null): (SignedRequestParts & { signature: string }) | null {
  const memberId = get(HDR_MEMBER);
  if (!memberId) return null;
  const target = get(HDR_PATH) ?? "";
  const q = target.indexOf("?");
  return {
    memberId,
    timestamp: get(HDR_TIMESTAMP) ?? "",
    signature: get(HDR_SIGNATURE) ?? "",
    bodySha256: get(HDR_BODY) ?? "",
    method: get(HDR_METHOD) ?? "",
    path: q === -1 ? target : target.slice(0, q),
    query: q === -1 ? "" : target.slice(q),
    userId: get(HDR_USER) || null,
  };
}
