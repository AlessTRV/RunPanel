import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { isDenied, requireMember } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { clearCluster, clusterState } from "@/services/cluster/state";

/**
 * A panel revoked us: forget the cluster. The replicated accounts stay, so a
 * panel-role install simply becomes a solo panel with the same users; a
 * managed node had no sessions to begin with.
 */
export async function POST() {
  const denied = await requireMember({ role: "panel" });
  if (isDenied(denied)) return denied;

  const state = await clusterState();
  const wasNode = state?.role === "node";
  await clearCluster();
  if (wasNode) {
    const db = await getDb();
    await db.deleteFrom("sessions").execute();
  }
  await audit({ userId: null, category: "security", action: "cluster.left", detail: `revocato da ${denied.member.name}` });
  return NextResponse.json({ success: true });
}
