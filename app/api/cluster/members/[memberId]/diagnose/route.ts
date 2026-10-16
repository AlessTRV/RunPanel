import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { SKEW_MS } from "@/lib/cluster-sign";
import { pingMember } from "@/services/cluster/client";
import { directoryHash } from "@/services/cluster/directory";
import { clusterState, getMember, listMembers } from "@/services/cluster/state";
import { panelRelease } from "@/services/panel-update/release";

export interface MemberDiagnosis {
  reachable: boolean;
  /** The signature was accepted: same secret on both sides. */
  signatureOk: boolean;
  sameCluster: boolean;
  version: string | null;
  versionMatch: boolean | null;
  /** Their clock minus ours, in milliseconds. */
  skewMs: number | null;
  skewOk: boolean | null;
  directoryMatch: boolean | null;
  error: string | null;
}

/** Ask a member who it is and compare notes: reachability, secret, version, clock, directory. */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ memberId: string }> }) {
  const denied = await requirePermission("nodes");
  if (isDenied(denied)) return denied;
  const { memberId } = await params;

  const state = await clusterState();
  const member = state ? await getMember(memberId) : null;
  if (!state || !member) return NextResponse.json({ error: "Server non trovato" }, { status: 404 });
  if (memberId === state.selfId) return NextResponse.json({ error: "È questo server" }, { status: 400 });

  const before = Date.now();
  const ping = await pingMember(member);
  const after = Date.now();
  const fresh = (await listMembers()).find((m) => m.id === memberId);

  if (!ping) {
    const error = fresh?.last_error ?? "Nessuna risposta";
    const result: MemberDiagnosis = {
      reachable: !/ECONN|ENOTFOUND|EHOSTUNREACH|tempo limite|Nessuna risposta|fetch failed/i.test(error),
      signatureOk: !/HTTP 401/.test(error),
      sameCluster: false,
      version: fresh?.version ?? null,
      versionMatch: null,
      skewMs: null,
      skewOk: null,
      directoryMatch: null,
      error,
    };
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  }

  const release = await panelRelease();
  const skewMs = Date.parse(ping.time) - Math.round((before + after) / 2);
  const result: MemberDiagnosis = {
    reachable: true,
    signatureOk: true,
    sameCluster: ping.clusterId === state.clusterId,
    version: ping.version,
    versionMatch: ping.version === release.label,
    skewMs,
    skewOk: Math.abs(skewMs) < SKEW_MS / 2,
    directoryMatch: ping.directoryHash === (await directoryHash()),
    error: null,
  };
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
