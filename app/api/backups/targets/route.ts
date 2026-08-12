import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { targetsCache } from "@/services/backup/catalog";

/**
 * What a policy can be pointed at.
 *
 * The database and volume lists come from the engines and from Docker's own
 * labels rather than from our rows, so the editor offers what exists right now
 * instead of what the panel last wrote down.
 */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  return NextResponse.json(await targetsCache.get());
}
