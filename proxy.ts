import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isSessionTokenValid } from "@/lib/auth";

/**
 * Deny-by-default in front of the API.
 *
 * Every handler under `app/api` already calls `requireAuth()` as its first
 * statement, and at the time of writing all of them still do. That is the
 * problem: the guarantee lives in a convention, and this panel runs shell
 * commands on the host, so the first route that ships without the line is a
 * full compromise rather than a bug.
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
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await isSessionTokenValid(token)) return NextResponse.next();

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export const config = {
  /**
   * Everything under `/api` except the three endpoints that cannot require a
   * session: signing in, signing out, and the GitHub webhook — which
   * authenticates with an HMAC over the body instead.
   *
   * Written as an exclusion rather than a list of protected paths so that a new
   * route is covered the moment it exists. Adding a public endpoint is then a
   * deliberate edit here, which is the direction the mistake should have to run.
   */
  matcher: ["/api/((?!auth/|webhooks/).*)"],
};
