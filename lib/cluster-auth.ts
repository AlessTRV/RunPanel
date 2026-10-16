import { createHmac, timingSafeEqual } from "node:crypto";

import { SKEW_MS, readSignedHeaders, verifyRequest } from "./cluster-sign";
import { getDb } from "./db";
import type { ClusterMembersTable } from "./db/schema";
import { clusterState } from "@/services/cluster/state";

/**
 * Is this request from another member of our cluster?
 *
 * Checked twice on purpose, like the session cookie: `proxy.ts` refuses a bad
 * signature before any handler runs and also checks that the signed method and
 * path are the request's real ones; `getSession()` and `requireMember()` check
 * the signature again from the headers alone, so a handler that somehow runs
 * without the proxy still trusts nothing it should not.
 *
 * A signature is also accepted once. The timestamp window alone would let a
 * captured request be sent again for five minutes — to the same path, or to a
 * page, which the proxy does not cover and where the signed path cannot be
 * compared. So every signature seen is remembered for the window, and a
 * second sighting is refused. The proxy records the first sighting and tells
 * the handler so, in a header only it can produce, that the handler's own
 * sighting is not a replay.
 */

export interface SignedCaller {
  member: ClusterMembersTable;
  /** The user the call acts for, or null for a member-to-member call. */
  userId: string | null;
}

/** Set by `proxy.ts` on the request it forwards: an HMAC of the signature it has already recorded. */
export const HDR_PROXIED = "x-runpanel-proxied";

const ref = globalThis as typeof globalThis & { __runpanelSeenSignatures?: Map<string, number> };
const seen = (ref.__runpanelSeenSignatures ??= new Map<string, number>());
const MAX_SEEN = 20_000;

/** Record a signature; false when it was already seen inside the window. */
function firstSighting(signature: string, now = Date.now()): boolean {
  const expiry = seen.get(signature);
  if (expiry !== undefined && expiry > now) return false;
  if (seen.size >= MAX_SEEN) {
    for (const [key, until] of seen) if (until <= now) seen.delete(key);
    if (seen.size >= MAX_SEEN) seen.clear();
  }
  seen.set(signature, now + SKEW_MS * 2);
  return true;
}

export function proxiedMark(secret: string, signature: string): string {
  return createHmac("sha256", secret).update(`proxied\n${signature}`).digest("hex");
}

function isProxiedMark(secret: string, signature: string, mark: string | null): boolean {
  if (!mark || !/^[0-9a-f]{64}$/.test(mark)) return false;
  const expected = Buffer.from(proxiedMark(secret, signature), "hex");
  const given = Buffer.from(mark, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function verifySignedHeaders(
  get: (name: string) => string | null,
  opts: {
    actual?: { method: string; path: string; query: string };
    bodySha256?: string;
    /** The proxy passes true: it records the sighting. Handlers pass nothing and trust its mark. */
    record?: boolean;
  } = {}
): Promise<(SignedCaller & { secret: string; markSecret: string }) | null> {
  const parts = readSignedHeaders(get);
  if (!parts) return null;

  if (opts.actual) {
    if (parts.method !== opts.actual.method.toUpperCase()) return null;
    if (parts.path !== opts.actual.path || parts.query !== opts.actual.query) return null;
  }
  if (opts.bodySha256 !== undefined && parts.bodySha256 !== opts.bodySha256) return null;

  const state = await clusterState();
  if (!state) return null;

  const db = await getDb();
  const member = await db.selectFrom("cluster_members").selectAll().where("id", "=", parts.memberId).executeTakeFirst();
  if (!member) return null;

  const secrets = [state.secret, ...(state.previousSecret ? [state.previousSecret] : [])];
  const secret = secrets.find((candidate) => verifyRequest(candidate, parts).ok);
  if (!secret) return null;

  if (opts.record) {
    if (!firstSighting(parts.signature)) return null;
  } else if (!isProxiedMark(state.secret, parts.signature, get(HDR_PROXIED))) {
    // Not through the proxy (a page, /api/auth, a route kept out of it): this
    // sighting is the first, or a replay.
    if (!firstSighting(parts.signature)) return null;
  }

  // The proxy marks with the current secret whatever the request was signed
  // with: the handler checks the mark against the current one, and a request
  // signed with the previous secret during the grace period is still valid.
  return { member, userId: parts.userId, secret, markSecret: state.secret };
}
