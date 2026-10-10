import { NextRequest, NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { trustedClientIp } from "@/lib/client-ip";
import { consumeRateLimit } from "@/lib/rate-limit";
import { inspectInvite, recordLogin, redeemInvite } from "@/lib/users";

/**
 * Invitation and reset links — public, like the login form.
 *
 * The token is 32 random bytes and only its hash is stored, so guessing is not
 * a strategy; the rate limit is there so trying is not cheap either.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 30;
const MAX_BODY_BYTES = 4 * 1024;

async function limited(request: NextRequest): Promise<NextResponse | null> {
  const ip = trustedClientIp(request);
  for (const key of ["invite:global", ...(ip ? [`invite:${ip}`] : [])]) {
    const limit = await consumeRateLimit(key, key === "invite:global" ? MAX_ATTEMPTS : 10, WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Troppi tentativi. Riprova tra ${Math.ceil(limit.retryAfter / 60)} minuti.` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
      );
    }
  }
  return null;
}

const invalid = () =>
  NextResponse.json({ error: "Link non valido o scaduto. Chiedi un nuovo invito." }, { status: 400 });

/** What a link is for, so the page can show the email it will set a password on. */
export async function GET(request: NextRequest) {
  const tooMany = await limited(request);
  if (tooMany) return tooMany;
  const invite = await inspectInvite(request.nextUrl.searchParams.get("token"));
  if (!invite) return invalid();
  return NextResponse.json({ email: invite.email, kind: invite.kind }, { headers: { "Cache-Control": "no-store" } });
}

/** Spend a link: set the password and sign in. */
export async function POST(request: NextRequest) {
  const tooMany = await limited(request);
  if (tooMany) return tooMany;

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Richiesta troppo grande" }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const { token, password } = (body ?? {}) as { token?: unknown; password?: unknown };
  if (typeof token !== "string") return invalid();
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return NextResponse.json({ error: "La password deve avere tra 8 e 128 caratteri" }, { status: 400 });
  }

  const userId = await redeemInvite(token, password);
  if (!userId) return invalid();

  await createSession(userId, {
    userAgent: request.headers.get("user-agent") ?? undefined,
    ip: trustedClientIp(request) ?? undefined,
  });
  await recordLogin(userId);
  await audit({ userId, category: "security", action: "auth.invite.redeemed", scope: "user", scopeId: userId, request });
  return NextResponse.json({ success: true });
}
