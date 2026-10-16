import { NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { visibleProjectIds, isVisible } from "@/lib/principal";
import { signedFetch } from "@/services/cluster/client";
import { clusterState, listMembers } from "@/services/cluster/state";

export interface MemberOverview {
  id: string;
  name: string;
  role: "panel" | "node";
  self: boolean;
  reachable: boolean;
  /** Projects the user can see there, and how many of them are running. */
  total: number | null;
  running: number | null;
  error: string | null;
}

/** Every member at a glance, as the signed-in user may see it: for the home page. */
export async function GET() {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;

  const state = await clusterState();
  if (!state) return NextResponse.json({ members: [] }, { headers: { "Cache-Control": "no-store" } });

  const members = await listMembers();
  const userId = denied.session.user.id;
  const results = await Promise.all(
    members.map(async (m): Promise<MemberOverview> => {
      const base = { id: m.id, name: m.name, role: m.role === "node" ? ("node" as const) : ("panel" as const), self: m.id === state.selfId };
      if (m.id === state.selfId) {
        const db = await getDb();
        const rows = await db.selectFrom("projects").select(["id", "status"]).execute();
        const visible = await visibleProjectIds(denied.principal);
        const mine = rows.filter((p) => isVisible(visible, p.id));
        return { ...base, reachable: true, total: mine.length, running: mine.filter((p) => p.status === "running").length, error: null };
      }
      try {
        const res = await signedFetch(m, "/api/projects", { userId, headersTimeoutMs: 5_000 });
        if (!res.ok) return { ...base, reachable: true, total: null, running: null, error: `HTTP ${res.status}` };
        const list = (await res.json()) as Array<{ status?: string }>;
        const total = Array.isArray(list) ? list.length : 0;
        const running = Array.isArray(list) ? list.filter((p) => p.status === "running").length : 0;
        return { ...base, reachable: true, total, running, error: null };
      } catch (err) {
        return { ...base, reachable: false, total: null, running: null, error: err instanceof Error ? err.message : "Errore" };
      }
    })
  );

  return NextResponse.json({ members: results }, { headers: { "Cache-Control": "no-store" } });
}
