import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { listSessions } from "@/lib/auth";

/** Devices currently signed in. Tokens are stored hashed and never returned. */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  return NextResponse.json(
    { sessions: await listSessions() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** Revoke one device. */
export async function DELETE(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Serve il parametro id" }, { status: 400 });
  }

  const db = await getDb();
  await db.deleteFrom("sessions").where("id", "=", id).execute();

  return NextResponse.json({ success: true, sessions: await listSessions() });
}
