import { NextRequest, NextResponse } from "next/server";
import {
  isFirstRun,
  setAdminPassword,
  getAdminPasswordHash,
  verifyPassword,
  createSession,
} from "@/lib/auth";

// Simple in-memory rate limiter: max 5 attempts per IP per 15 minutes
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again in 15 minutes." },
      { status: 429 }
    );
  }

  const body = await request.json();
  const { password, setup } = body;

  if (!password || typeof password !== "string" || password.length > 128) {
    return NextResponse.json({ error: "Invalid password" }, { status: 400 });
  }

  // First-run setup
  if (setup && isFirstRun()) {
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }
    await setAdminPassword(password);
    await createSession();
    // Clear rate limit on successful setup
    attempts.delete(ip);
    return NextResponse.json({ success: true });
  }

  // Normal login
  const hash = getAdminPasswordHash();
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

  // Clear rate limit on successful login
  attempts.delete(ip);
  await createSession();
  return NextResponse.json({ success: true });
}
