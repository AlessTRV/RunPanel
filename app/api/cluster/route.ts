import { NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { clusterState, listMembers } from "@/services/cluster/state";
import { panelRelease } from "@/services/panel-update/release";

export interface ClusterMemberView {
  id: string;
  name: string;
  url: string;
  role: "panel" | "node";
  status: "unknown" | "ok" | "unreachable";
  version: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  self: boolean;
}

export interface ClusterView {
  solo: boolean;
  selfId: string | null;
  role: "panel" | "node" | null;
  selfVersion: string;
  members: ClusterMemberView[];
}

/** The cluster as this panel sees it. Never the secret. */
export async function GET() {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;

  const state = await clusterState();
  const release = await panelRelease();
  const members = state ? await listMembers() : [];
  const view: ClusterView = {
    solo: state === null,
    selfId: state?.selfId ?? null,
    role: state?.role ?? null,
    selfVersion: release.label,
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      url: m.url,
      role: m.role === "node" ? "node" : "panel",
      status: m.id === state?.selfId ? "ok" : m.status === "ok" || m.status === "unreachable" ? m.status : "unknown",
      version: m.id === state?.selfId ? release.label : m.version,
      lastSeenAt: m.last_seen_at,
      lastError: m.id === state?.selfId ? null : m.last_error,
      self: m.id === state?.selfId,
    })),
  };
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
