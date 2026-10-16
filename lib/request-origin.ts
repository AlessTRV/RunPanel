import { NextRequest, NextResponse } from "next/server";

/**
 * Refuse a write that a page on another origin sent.
 *
 * The session cookie is SameSite=Lax, which stops other *sites* but not other
 * origins on the same host: an app this panel deployed on another port is
 * same-site, and its pages could send blind state-changing requests carrying
 * the operator's cookie. Browsers tell us where a request came from; anything
 * that is not this exact origin gets no write. Clients that send neither header
 * (curl, the test harness, another member of the cluster) are not browsers and
 * carry no ambient cookie risk.
 *
 * `proxy.ts` applies this to everything under `/api`; the few routes kept out
 * of the proxy because their bodies are large call it themselves.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isCrossOriginWrite(request: NextRequest): boolean {
  if (SAFE_METHODS.has(request.method)) return false;

  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";

  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** The response to send instead, or null when the request may go on. */
export function refuseCrossOrigin(request: NextRequest): NextResponse | null {
  if (!isCrossOriginWrite(request)) return null;
  return NextResponse.json({ error: "Richiesta da un'origine diversa rifiutata" }, { status: 403 });
}
