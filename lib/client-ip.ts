import type { NextRequest } from "next/server";
import { getEnv } from "./env";

/**
 * The client address, or null when there is no trustworthy one.
 *
 * Next 16 does not hand a route handler the socket address, so the only source
 * is `X-Forwarded-For` — and that header is worth something only where a proxy
 * the operator controls wrote part of it.
 *
 * Every hop APPENDS to the list, so with n trusted proxies the address the
 * outermost one actually saw is the nth entry from the RIGHT. Everything to its
 * left arrived from the client and is whatever they felt like typing. Reading
 * the leftmost entry — which is what this panel used to do — turned the login
 * rate limit into a counter the attacker could reset per request.
 *
 * With no proxy configured there is nothing to trust and this returns null,
 * rather than a value that reads like an identity but is chosen by the caller.
 */
export function trustedClientIp(request: NextRequest): string | null {
  const hops = getEnv().trustedProxyHops;
  if (hops <= 0) return null;

  const chain = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  // Fewer entries than there are proxies means the request did not arrive the
  // way it was configured to. Unusable is the safe reading, not "use the first".
  if (chain.length < hops) return null;

  return chain[chain.length - hops] ?? null;
}
