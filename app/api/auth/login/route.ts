import { NextRequest, NextResponse } from "next/server";
import {
  isFirstRun,
  setAdminPassword,
  getAdminPasswordHash,
  verifyPassword,
  createSession,
} from "@/lib/auth";
import { clearRateLimit, consumeRateLimit } from "@/lib/rate-limit";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function clientIp(request: NextRequest): string {
  // Only the first hop is meaningful; the rest of an X-Forwarded-For chain is
  // client-supplied and trivially spoofed.
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const limitKey = `login:${ip}`;

  const limit = await consumeRateLimit(limitKey, MAX_ATTEMPTS, WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Troppi tentativi. Riprova tra ${Math.ceil(limit.retryAfter / 60)} minuti.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
    );
  }

  const body = await request.json();
  const { password, setup } = body;

  if (!password || typeof password !== "string" || password.length > 128) {
    return NextResponse.json({ error: "Invalid password" }, { status: 400 });
  }

  const sessionMeta = {
    userAgent: request.headers.get("user-agent") ?? undefined,
    ip,
  };

  // First-run setup
  if (setup && (await isFirstRun())) {
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }
    await setAdminPassword(password);
    await createSession(sessionMeta);
    await clearRateLimit(limitKey);
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
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  await clearRateLimit(limitKey);
  await createSession(sessionMeta);
  return NextResponse.json({ success: true });
}
