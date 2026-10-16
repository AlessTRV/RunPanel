import { NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { broadcastDirectory } from "@/services/cluster/sync";

/** Exchange the directory with every member now, and say how each one went. */
export async function POST() {
  const denied = await requirePermission("nodes");
  if (isDenied(denied)) return denied;
  const results = await broadcastDirectory({ wait: true });
  return NextResponse.json({ members: results }, { headers: { "Cache-Control": "no-store" } });
}
