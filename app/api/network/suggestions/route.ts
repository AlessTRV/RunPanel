import os from "os";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { networksFrom, normalizeAddress } from "@/lib/ip-access";
import { trustedClientIp } from "@/lib/client-ip";

/**
 * The networks worth offering as tick boxes when restricting a port.
 *
 * Server-side because only the server can see the host's interfaces, and
 * because typing a CIDR by hand is precisely where an operator locks themselves
 * out of their own database.
 *
 * The caller's own address is offered too, when there is a trustworthy one.
 * `trustedClientIp` returns null unless a proxy the operator configured wrote
 * part of `X-Forwarded-For`, so behind an unconfigured proxy the suggestion is
 * simply absent — a guessed address here would be a caller-chosen value
 * presented as a fact, on the one screen where believing it locks you out.
 */
export async function GET(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const networks = networksFrom(os.networkInterfaces());
  const client = trustedClientIp(request);

  return NextResponse.json(
    {
      networks,
      clientIp: client ? normalizeAddress(client) : null,
    },
    // The host's interface list is not something to leave in a shared cache.
    { headers: { "Cache-Control": "no-store" } }
  );
}
