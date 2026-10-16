import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isSessionTokenValid } from "@/lib/auth";
import { HDR_PROXIED, proxiedMark, verifySignedHeaders } from "@/lib/cluster-auth";
import { EMPTY_BODY_SHA256, HDR_MEMBER, sha256Hex } from "@/lib/cluster-sign";
import { refuseCrossOrigin } from "@/lib/request-origin";

/**
 * Deny-by-default in front of the API.
 *
 * Every handler under `app/api` already calls a guard as its first statement,
 * and at the time of writing all of them still do. That is the problem: the
 * guarantee lives in a convention, and this panel runs shell commands on the
 * host, so the first route that ships without the line is a full compromise
 * rather than a bug.
 *
 * This does not replace those calls — it is the floor underneath them. Both run,
 * both are one indexed point-lookup, and a route that loses its guard is still
 * refused here.
 *
 * `proxy.ts` is Next 16's name for what used to be `middleware.ts`; it runs on
 * the Node.js runtime, which is what makes reaching the session store possible
 * at all. Setting `runtime` here is an error, so it is not set.
 */
export async function proxy(request: NextRequest) {
  const refused = refuseCrossOrigin(request);
  if (refused) return refused;

  // A call from another member of the cluster carries a signature instead of
  // a cookie. The signed method and path must be the request's own, and the
  // signed body hash must match what actually arrived: the body is cloned for
  // the proxy, so reading it here leaves the handler's copy intact. The
  // sighting is recorded here, and the handler is told so in a header only
  // this process can produce, so its own check does not read as a replay.
  if (request.headers.get(HDR_MEMBER)) {
    const bodySha256 = hasBody(request) ? sha256Hex(new Uint8Array(await request.arrayBuffer())) : EMPTY_BODY_SHA256;
    const caller = await verifySignedHeaders((name) => request.headers.get(name), {
      actual: { method: request.method, path: request.nextUrl.pathname, query: request.nextUrl.search },
      bodySha256,
      record: true,
    });
    if (!caller) return NextResponse.json({ error: "Firma non valida" }, { status: 401 });
    const headers = new Headers(request.headers);
    headers.set(HDR_PROXIED, proxiedMark(caller.markSecret, request.headers.get("x-runpanel-signature") ?? ""));
    return NextResponse.next({ request: { headers } });
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await isSessionTokenValid(token)) return NextResponse.next();

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const BODYLESS = new Set(["GET", "HEAD", "OPTIONS"]);

function hasBody(request: NextRequest): boolean {
  return !BODYLESS.has(request.method) && request.body !== null;
}

export const config = {
  /**
   * Everything under `/api` except the endpoints that cannot require a
   * session: signing in, signing out, the GitHub webhook — which
   * authenticates with an HMAC over the body instead — and a fresh install
   * asking to join the cluster with a one-time token.
   *
   * Two more are kept out for a different reason. Next clones the body of
   * every request the proxy matches so the proxy and the handler can both read
   * it, buffering the clone in memory and cutting it off at 10 MB. The ZIP
   * upload and its forwarded form to another server carry up to 100 MB: in
   * front of them the proxy would either truncate the file or double its
   * memory on a machine that is also running the projects. Both routes call
   * `requireUser` first and apply the same cross-origin check themselves, and
   * `authz-coverage-unit` keeps it that way.
   *
   * Written as an exclusion rather than a list of protected paths so that a new
   * route is covered the moment it exists. Adding a public endpoint is then a
   * deliberate edit here, which is the direction the mistake should have to run.
   */
  matcher: ["/api/((?!auth/|webhooks/|cluster/join|upload$|nodes/).*)"],
};
