import { isDenied, requireUser } from "@/lib/auth-guard";
import { serverWarnings, type ServerSummary, type ServerWarning } from "@/lib/cluster-merge";
import { json, perServer } from "@/services/cluster/aggregate";
import { fanOut } from "@/services/cluster/fanout";
import { listMembers } from "@/services/cluster/state";
import { panelRelease } from "@/services/panel-update/release";

export interface ServerCard {
  memberId: string;
  memberName: string;
  self: boolean;
  role: "panel" | "node";
  url: string;
  reachable: boolean;
  /** Answered, but predates /api/server-summary: an older panel version. */
  outdated: boolean;
  /** Version the member last reported to this panel, for when it cannot summarise itself. */
  version: string | null;
  error: string | null;
  lastSeenAt: string | null;
  summary: ServerSummary | null;
  warnings: ServerWarning[];
}

/** Every server at a glance: what /api/server-summary says on each, plus what needs attention. */
export async function GET() {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;

  const [results, members, release] = await Promise.all([
    fanOut<ServerSummary>("/api/server-summary", { userId: denied.session.user.id }),
    listMembers(),
    panelRelease(),
  ]);

  const statusOf = new Map(results.map((r) => [r.member.id, r.status]));
  const servers: ServerCard[] = perServer(results).map((s) => {
    const row = members.find((m) => m.id === s.memberId);
    const reachable = s.reachable;
    // A server on an older release has no /api/server-summary yet: it answers 404.
    const outdated = reachable && s.data === null && statusOf.get(s.memberId) === 404;
    const version = s.data?.version ?? row?.version ?? null;
    return {
      memberId: s.memberId,
      memberName: s.memberName,
      self: s.self,
      role: row?.role === "node" ? "node" : "panel",
      url: row?.url ?? "",
      reachable,
      outdated,
      version,
      error: outdated ? null : s.error,
      lastSeenAt: s.self ? new Date().toISOString() : (row?.last_seen_at ?? null),
      summary: s.data,
      warnings: outdated
        ? [{ kind: "version", tone: "warn", text: `Versione ${version ?? "precedente"}` }]
        : serverWarnings(s.data, { reachable: reachable && s.data !== null, panelVersion: release.label }),
    };
  });

  return json({ servers, panelVersion: release.label });
}
