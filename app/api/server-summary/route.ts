import { isDenied, requireUser } from "@/lib/auth-guard";
import { hasPermission } from "@/lib/authz";
import type { ServerSummary } from "@/lib/cluster-merge";
import { getDb } from "@/lib/db";
import { isVisible, visibleProjectIds, visibleServiceIds } from "@/lib/principal";
import { json } from "@/services/cluster/aggregate";
import { diagnosticsCache } from "@/services/diagnostics";
import { isDockerAvailable } from "@/services/docker/cli";
import { hostMetrics } from "@/services/host-metrics";
import { lastCheck } from "@/services/panel-update/check";
import { panelRelease } from "@/services/panel-update/release";

/**
 * This server at a glance, for the servers overview of the cluster: version,
 * Docker, host metrics, projects and services, open problems and pending
 * update. Each part follows the permission that guards its own page, so an
 * account without `monitor` gets no metrics and so on; counts are of what the
 * account can see.
 */
export async function GET() {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;
  const { principal } = denied;
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(principal, p);

  const db = await getDb();
  const [release, docker, projects, services, vp, vs] = await Promise.all([
    panelRelease(),
    isDockerAvailable().catch(() => false),
    db.selectFrom("projects").select(["id", "status"]).execute(),
    db.selectFrom("services").select(["id", "status"]).execute(),
    visibleProjectIds(principal),
    visibleServiceIds(principal),
  ]);
  const mine = projects.filter((p) => isVisible(vp, p.id));
  const myServices = services.filter((s) => isVisible(vs, s.id));

  let metrics: ServerSummary["metrics"] = null;
  if (can("monitor")) {
    const m = await hostMetrics();
    metrics = { cpu: m.cpu, memory: { total: m.memory.total, used: m.memory.used }, disk: m.disk, uptime: m.uptime };
  }

  let problems: number | null = null;
  if (can("diagnostics")) {
    const checks = await diagnosticsCache.get({ fresh: false });
    problems = checks.filter((c) => c.tone === "warn" || c.tone === "danger").length;
  }

  let update: ServerSummary["update"] = null;
  if (can("updates")) {
    const check = await lastCheck();
    update = { behind: check?.behind ?? 0 };
  }

  const summary: ServerSummary = {
    version: release.label,
    docker,
    metrics,
    projects: { total: mine.length, running: mine.filter((p) => p.status === "running").length },
    services: { total: myServices.length, running: myServices.filter((s) => s.status === "running").length },
    problems,
    update,
  };
  return json(summary);
}
