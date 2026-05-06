import { NextRequest, NextResponse } from "next/server";
import {
  isFirstRun,
  setAdminPassword,
  getAdminPasswordHash,
  verifyPassword,
  createSession,
} from "@/lib/auth";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { password, setup } = body;

  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
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

  await createSession();
  return NextResponse.json({ success: true });
}
