import crypto from "crypto";

/**
 * The token that must accompany first-run setup.
 *
 * Setting the admin password is necessarily an unauthenticated call — there is
 * no account to authenticate against yet. Without a shared secret, whoever
 * reaches a freshly started panel before its operator becomes its
 * administrator, and an administrator here has a shell on the host. The window
 * is not even hard to find: `GET /api/auth/check` reports `firstRun` to anyone
 * who asks. On a panel reachable from the internet that is a race the operator
 * can lose.
 *
 * Printed to the server log at boot, the way Jenkins hands over its initial
 * admin password. A restart mints a new one, so an instance left unclaimed does
 * not keep the same answer forever.
 *
 * `RUNPANEL_SETUP_TOKEN` pins it instead, which is what an automated
 * provisioning run — and the test suite — needs.
 */
const globalRef = globalThis as typeof globalThis & {
  __runpanelSetupToken?: string;
};

export function getSetupToken(): string {
  if (!globalRef.__runpanelSetupToken) {
    const pinned = process.env.RUNPANEL_SETUP_TOKEN?.trim();
    globalRef.__runpanelSetupToken =
      pinned && pinned.length > 0 ? pinned : crypto.randomBytes(24).toString("hex");
  }
  return globalRef.__runpanelSetupToken;
}

/**
 * Constant-time comparison against the expected token.
 *
 * `timingSafeEqual` throws when the lengths differ, which is itself the answer
 * — a wrong length is a wrong token.
 */
export function isValidSetupToken(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;

  const expected = Buffer.from(getSetupToken());
  const given = Buffer.from(candidate);

  try {
    return crypto.timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}
