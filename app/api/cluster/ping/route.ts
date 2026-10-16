import { NextResponse } from "next/server";
import { isDenied, requireMember } from "@/lib/auth-guard";
import { nowIso } from "@/lib/db";
import { directoryHash } from "@/services/cluster/directory";
import { clusterState, recordMemberSeen } from "@/services/cluster/state";
import { panelRelease } from "@/services/panel-update/release";

/** Who we are, for another member: identity, version, clock and directory hash. */
export async function GET() {
  const denied = await requireMember();
  if (isDenied(denied)) return denied;

  const state = await clusterState();
  if (!state) return NextResponse.json({ error: "Nessun cluster" }, { status: 404 });

  await recordMemberSeen(denied.member.id, {});
  const release = await panelRelease();
  return NextResponse.json(
    {
      memberId: state.selfId,
      clusterId: state.clusterId,
      role: state.role,
      version: release.label,
      time: nowIso(),
      directoryHash: await directoryHash(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
