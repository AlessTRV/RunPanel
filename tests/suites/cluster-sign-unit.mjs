import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * A member's word on a request.
 *
 * Every call between two RunPanel installs is accepted on the strength of one
 * HMAC. If it verifies something it should not — an old request, a request
 * re-pointed at another path, a body swapped under a valid header — a member
 * runs commands it was never asked to run. If it refuses what it should
 * accept, the cluster silently stops working.
 *
 * Standalone: `lib/cluster-sign.ts` imports only `node:crypto`.
 */
export const meta = { name: "cluster-sign-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("cluster-sign-unit");
  const sign = await import(pathToFileURL(join(repoRoot, "lib", "cluster-sign.ts")).href);
  const { signRequest, verifyRequest, signedHeaders, readSignedHeaders, sha256Hex, hashToken, EMPTY_BODY_SHA256, SKEW_MS } = sign;

  const secret = "a".repeat(64);
  const now = 1_800_000_000_000;
  const base = {
    method: "POST",
    path: "/api/projects",
    query: "?x=1",
    timestamp: String(now),
    memberId: "m1",
    userId: "u1",
    bodySha256: sha256Hex('{"name":"demo"}'),
  };

  // --- round trip --------------------------------------------------------------
  {
    const signature = signRequest(secret, base);
    r.check("a signed request verifies", verifyRequest(secret, { ...base, signature }, now).ok === true);
    r.check("the signature is 64 hex chars", /^[0-9a-f]{64}$/.test(signature), signature);
    r.check("lower-case method signs the same", signRequest(secret, { ...base, method: "post" }) === signature);
    r.check("member-to-member (no user) verifies", (() => {
      const p = { ...base, userId: null };
      return verifyRequest(secret, { ...p, signature: signRequest(secret, p) }, now).ok === true;
    })());
  }

  // --- what must be refused ----------------------------------------------------
  {
    const signature = signRequest(secret, base);
    const refuse = (label, patch, reason) => {
      const res = verifyRequest(secret, { ...base, signature, ...patch }, now);
      r.check(`${label} is refused`, res.ok === false && res.reason === reason, JSON.stringify(res));
    };
    refuse("another secret", { signature: signRequest("b".repeat(64), base) }, "signature");
    refuse("another path", { path: "/api/projects/x/deploy" }, "signature");
    refuse("another query", { query: "" }, "signature");
    refuse("another method", { method: "DELETE" }, "signature");
    refuse("another user", { userId: "u2" }, "signature");
    refuse("a dropped user", { userId: null }, "signature");
    refuse("another body", { bodySha256: EMPTY_BODY_SHA256 }, "signature");
    refuse("another member id", { memberId: "m2" }, "signature");
    refuse("a flipped signature bit", { signature: (signature[0] === "0" ? "1" : "0") + signature.slice(1) }, "signature");
    refuse("a malformed signature", { signature: "zz" }, "malformed");
    refuse("a malformed timestamp", { timestamp: "yesterday" }, "malformed");
    refuse("a relative path", { path: "api/projects" }, "malformed");
  }

  // --- the replay window -------------------------------------------------------
  {
    const signature = signRequest(secret, base);
    const at = (t) => verifyRequest(secret, { ...base, signature }, t);
    r.check("still valid just inside the window", at(now + SKEW_MS - 1).ok === true);
    r.check("refused just past the window (replay)", at(now + SKEW_MS + 1).reason === "skew");
    r.check("refused when the clock is behind too", at(now - SKEW_MS - 1).reason === "skew");
  }

  // --- the headers round trip through a fetch-like header bag ------------------
  {
    const headers = signedHeaders(secret, { ...base, timestamp: undefined });
    const bag = new Map(Object.entries(headers));
    const parsed = readSignedHeaders((name) => bag.get(name) ?? null);
    r.check("readSignedHeaders recovers the parts", parsed?.memberId === "m1" && parsed?.userId === "u1" && parsed?.path === "/api/projects" && parsed?.query === "?x=1", JSON.stringify(parsed));
    const res = verifyRequest(secret, parsed, Number(parsed.timestamp));
    r.check("headers built by signedHeaders verify", res.ok === true, JSON.stringify(res));
    r.check("an unsigned request reads as null", readSignedHeaders(() => null) === null);
    const noUser = signedHeaders(secret, { ...base, userId: null });
    r.check("no user, no user header", !("x-runpanel-user" in noUser));
  }

  r.check("hashToken is sha256 hex", hashToken("abc") === sha256Hex("abc") && /^[0-9a-f]{64}$/.test(hashToken("abc")));
  r.check("the empty body hash constant is right", sha256Hex("") === EMPTY_BODY_SHA256);

  return r.result();
}
