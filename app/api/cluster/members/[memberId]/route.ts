import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { bumpedUpdatedAt } from "@/lib/cluster-directory";
import { patchMemberSchema } from "@/lib/cluster-schema";
import { getDb, nowIso } from "@/lib/db";
import { signedFetch } from "@/services/cluster/client";
import { tombstone } from "@/services/cluster/directory";
import { clusterState, getMember, setClusterRole } from "@/services/cluster/state";
import { broadcastDirectory } from "@/services/cluster/sync";

type Params = { params: Promise<{ memberId: string }> };

const notFound = () => NextResponse.json({ error: "Server non trovato" }, { status: 404 });

/** Rename a member, change its address or its role. Replicated to everyone. */
export async function PATCH(request: NextRequest, { params }: Params) {
  const denied = await requirePermission("nodes");
  if (isDenied(denied)) return denied;
  const { memberId } = await params;

  const state = await clusterState();
  const member = state ? await getMember(memberId) : null;
  if (!state || !member) return notFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = patchMemberSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
  }

  const db = await getDb();
  await db
    .updateTable("cluster_members")
    .set({ ...parsed.data, updated_at: bumpedUpdatedAt(member.updated_at, nowIso()) })
    .where("id", "=", memberId)
    .execute();

  if (memberId === state.selfId && parsed.data.role && parsed.data.role !== state.role) {
    await setClusterRole(parsed.data.role);
    // A panel that becomes a managed node has no sign-in of its own any more.
    if (parsed.data.role === "node") await db.deleteFrom("sessions").execute();
  }

  await audit({
    userId: denied.session.user.id,
    category: "config",
    action: "cluster.member.update",
    detail: `${member.name}: ${Object.keys(parsed.data).join(", ")}`,
    request,
  });
  await broadcastDirectory({ wait: true });
  return NextResponse.json({ success: true });
}

/**
 * Revoke a member. It is told to leave (best effort: it may be down), then
 * forgotten here and, through the tombstone, everywhere else. Its copy of the
 * directory stays on its disk, which is why the page suggests rotating the
 * secret afterwards.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const denied = await requirePermission("nodes");
  if (isDenied(denied)) return denied;
  const { memberId } = await params;

  const state = await clusterState();
  const member = state ? await getMember(memberId) : null;
  if (!state || !member) return notFound();
  if (memberId === state.selfId) {
    return NextResponse.json({ error: "Questo server non può revocare sé stesso" }, { status: 400 });
  }

  let told = false;
  try {
    const res = await signedFetch(member, "/api/cluster/leave", { method: "POST", headersTimeoutMs: 8_000 });
    told = res.ok;
  } catch {
    told = false;
  }

  const db = await getDb();
  await tombstone("member", memberId);
  await db.deleteFrom("cluster_members").where("id", "=", memberId).execute();

  await audit({
    userId: denied.session.user.id,
    category: "security",
    action: "cluster.member.revoke",
    detail: `${member.name} ${member.url}${told ? "" : " (non raggiunto)"}`,
    request,
  });
  await broadcastDirectory({ wait: true });
  return NextResponse.json({ success: true, told });
}
