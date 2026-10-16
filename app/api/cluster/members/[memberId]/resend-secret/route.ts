import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { pushSecret } from "@/services/cluster/secret";
import { SECRET_GRACE_MS, clusterState, getMember } from "@/services/cluster/state";

/**
 * Give the current secret to a member that missed a rotation.
 *
 * That member still holds the previous secret, so the request is signed with
 * it — which only works while this panel still keeps the previous one, in the
 * grace period after the rotation. Past it there is nothing both sides share:
 * the member has to be revoked and reinstalled with an empty data folder.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ memberId: string }> }) {
  const denied = await requirePermission("nodes");
  if (isDenied(denied)) return denied;
  const { memberId } = await params;

  const state = await clusterState();
  const member = state ? await getMember(memberId) : null;
  if (!state || !member) return NextResponse.json({ error: "Server non trovato" }, { status: 404 });
  if (memberId === state.selfId) return NextResponse.json({ error: "È questo server" }, { status: 400 });

  if (!state.previousSecret) {
    return NextResponse.json(
      {
        error: `Nessuna rotazione negli ultimi ${SECRET_GRACE_MS / 60_000} minuti: ${member.name} non ha un segreto in comune con questo pannello. Revocalo e reinstallalo con una cartella data vuota.`,
      },
      { status: 409 }
    );
  }

  const result = await pushSecret(member, state.secret, state.previousSecret);
  await audit({
    userId: denied.session.user.id,
    category: "security",
    action: "cluster.secret.resend",
    detail: `${member.name}${result.ok ? "" : ` (non riuscito: ${result.error})`}`,
    request,
  });
  if (!result.ok) return NextResponse.json({ error: `${member.name}: ${result.error}` }, { status: 502 });
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
