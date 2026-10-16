import { isDenied, requirePermission } from "@/lib/auth-guard";
import { mergeByMember } from "@/lib/cluster-merge";
import { json } from "@/services/cluster/aggregate";
import { fanOut, memberStatuses } from "@/services/cluster/fanout";

/**
 * Backups of every server: policies, recent runs, destinations, each server's
 * summary and target catalog (to name what a policy saves). Every row is
 * tagged with its server, and every server applies the user's own backup
 * access.
 */
export async function GET() {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;
  const userId = denied.session.user.id;

  const [policies, runs, destinations, catalogs] = await Promise.all([
    fanOut<{ policies: unknown[] }>("/api/backups/policies", { userId }),
    fanOut<{ runs: unknown[]; activeRunId: string | null; overview: unknown }>("/api/backups/runs?limit=25", { userId }),
    fanOut<{ destinations: unknown[] }>("/api/backups/destinations", { userId }),
    fanOut<unknown>("/api/backups/targets", { userId, timeoutMs: 10_000 }),
  ]);

  return json({
    policies: mergeByMember(policies.map((r) => ({ member: r.member, items: r.data?.policies ?? [] }))),
    runs: mergeByMember(runs.map((r) => ({ member: r.member, items: r.data?.runs ?? [] }))),
    destinations: mergeByMember(destinations.map((r) => ({ member: r.member, items: r.data?.destinations ?? [] }))),
    perServer: runs.map((r) => ({
      memberId: r.member.id,
      activeRunId: r.data?.activeRunId ?? null,
      overview: r.data?.overview ?? null,
      catalog: catalogs.find((c) => c.member.id === r.member.id)?.data ?? null,
    })),
    members: memberStatuses(runs),
  });
}
