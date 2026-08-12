import { NextRequest, NextResponse } from "next/server";
import {
  isFirstRun,
  claimAdminPassword,
  getAdminPasswordHash,
  verifyPassword,
  createSession,
} from "@/lib/auth";
import { trustedClientIp } from "@/lib/client-ip";
import { isValidSetupToken } from "@/lib/setup-token";
import { clearRateLimit, consumeRateLimit } from "@/lib/rate-limit";

/** Per client address, once there is a client address worth counting. */
const MAX_ATTEMPTS_PER_IP = 5;
/**
 * Across everyone, always.
 *
 * There is exactly one account here, so what is worth protecting is the account
 * rather than any particular source — and with no proxy configured there is no
 * trustworthy source anyway, which makes this the only limit that applies.
 *
 * Without a client identity the choice is unavoidable: a low ceiling resists
 * guessing but lets anyone lock the operator out for the window, a high one
 * does the reverse. 20 per quarter hour is well under 2000 attempts a day
 * against a password of at least eight characters, and far enough above a
 * mistyped password that an operator will not meet it. Configure
 * `RUNPANEL_TRUSTED_PROXY_HOPS` and the tighter per-address limit applies too.
 */
const MAX_ATTEMPTS_GLOBAL = 20;
const GLOBAL_KEY = "login:global";
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  const ip = trustedClientIp(request);

  // Both are consumed on every attempt. The per-address bucket only exists when
  // `RUNPANEL_TRUSTED_PROXY_HOPS` says an address can be believed — counting by
  // a header the caller chooses is not a limit, it is a formality.
  const buckets = [{ key: GLOBAL_KEY, limit: MAX_ATTEMPTS_GLOBAL }];
  if (ip) buckets.unshift({ key: `login:${ip}`, limit: MAX_ATTEMPTS_PER_IP });

  for (const bucket of buckets) {
    const limit = await consumeRateLimit(bucket.key, bucket.limit, WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Troppi tentativi. Riprova tra ${Math.ceil(limit.retryAfter / 60)} minuti.` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
      );
    }
  }

  // A malformed body is a bad request, not a crash.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const { password, setup, setupToken } = (body ?? {}) as {
    password?: unknown;
    setup?: unknown;
    setupToken?: unknown;
  };

  if (!password || typeof password !== "string" || password.length > 128) {
    return NextResponse.json({ error: "Password errata" }, { status: 400 });
  }

  const sessionMeta = {
    userAgent: request.headers.get("user-agent") ?? undefined,
    ip: ip ?? undefined,
  };

  const clearBuckets = () => Promise.all(buckets.map((bucket) => clearRateLimit(bucket.key)));

  // First-run setup
  if (setup && (await isFirstRun())) {
    if (!isValidSetupToken(setupToken)) {
      return NextResponse.json(
        { error: "Token di setup mancante o errato. Lo trovi nel log di avvio del pannello." },
        { status: 403 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "La password deve avere almeno 8 caratteri" },
        { status: 400 }
      );
    }

    // Claimed rather than written: `isFirstRun()` above is a read, and two
    // requests can pass it together.
    if (!(await claimAdminPassword(password))) {
      return NextResponse.json(
        { error: "Il pannello è già stato configurato. Ricarica la pagina." },
        { status: 409 }
      );
    }

    await createSession(sessionMeta);
    await clearBuckets();
    return NextResponse.json({ success: true });
  }

  // Normal login
  const hash = await getAdminPasswordHash();
  if (!hash) {
    return NextResponse.json(
      { error: "Panel not set up. Please refresh the page." },
      { status: 400 }
    );
  }

  const valid = await verifyPassword(password, hash);
  if (!valid) {
    return NextResponse.json({ error: "Password errata" }, { status: 401 });
  }

  await clearBuckets();
  await createSession(sessionMeta);
  return NextResponse.json({ success: true });
}
