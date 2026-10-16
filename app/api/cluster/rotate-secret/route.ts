import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { pushSecretToAll } from "@/services/cluster/secret";
import { clusterState, installSecret, listMembers, newSecret } from "@/services/cluster/state";

/**
 * Replace the shared secret everywhere. Each member gets the new one in a
 * request signed with the old, with one retry for those that did not answer;
 * this panel switches last. A member still left out can be given the secret
 * again from the Servers page while the old one is in its grace period.
 */
export async function POST(request: NextRequest) {
  const denied = await requirePermission("nodes");
  if (isDenied(denied)) return denied;

  const state = await clusterState();
  if (!state) return NextResponse.json({ error: "Questo server non fa parte di un cluster" }, { status: 400 });

  const secret = newSecret();
  const members = (await listMembers()).filter((m) => m.id !== state.selfId);
  const results = await pushSecretToAll(members, secret);

  await installSecret(secret);
  await audit({
    userId: denied.session.user.id,
    category: "security",
    action: "cluster.secret.rotate",
    detail: results.filter((r) => !r.ok).map((r) => `${r.name} non aggiornato`).join(", ") || null,
    request,
  });
  return NextResponse.json({ success: true, members: results }, { headers: { "Cache-Control": "no-store" } });
}
