import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { processManager } from "@/services/process-manager";
import { containerStats } from "@/services/docker/stats";
import { dockerTry, lines } from "@/services/docker/cli";
import { hostMetrics } from "@/services/host-metrics";

const UPTIME_FORMAT = "{{.Name}}|{{.State.Running}}|{{.State.StartedAt}}";

/**
 * Uptime for every running container, in one call.
 *
 * Uptime is not in the stats stream, so it has to be inspected — but this was
 * one `docker inspect` per container on an endpoint the monitor page polls
 * every 3 seconds. Ten services meant ten process spawns every 3 seconds,
 * forever, for a number that advances by itself.
 *
 * `docker inspect` takes any number of names, so one spawn answers for all of
 * them. The name is included in the format because that is what makes the
 * result a map rather than a list whose order has to be trusted.
 */
async function containerUptimes(names: string[]): Promise<Map<string, number>> {
  const uptimes = new Map<string, number>();
  if (names.length === 0) return uptimes;

  const collect = (line: string) => {
    const [name, running, startedAt] = line.split("|");
    if (!name || running !== "true" || !startedAt) return;
    const started = new Date(startedAt).getTime();
    if (Number.isNaN(started)) return;
    // `.Name` comes back with a leading slash.
    uptimes.set(name.replace(/^\//, ""), Math.floor((Date.now() - started) / 1000));
  };

  const batch = await dockerTry(["inspect", ...names, "--format", UPTIME_FORMAT], {
    timeout: 5_000,
  });

  if (batch) {
    lines(batch.stdout).forEach(collect);
    return uptimes;
  }

  // A single name docker does not recognise fails the whole batch — a container
  // removed behind the panel's back, which the status column may not know about
  // yet. Ask one at a time so the others still report.
  const singles = await Promise.all(
    names.map((name) => dockerTry(["inspect", name, "--format", UPTIME_FORMAT], { timeout: 5_000 }))
  );
  for (const result of singles) {
    if (result) lines(result.stdout).forEach(collect);
  }
  return uptimes;
}

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const db = await getDb();
  void containerStats.ensureStarted();

  const [server, projects, services] = await Promise.all([
    hostMetrics(),
    db
      .selectFrom("projects")
      .select(["id", "name", "slug", "runtime_type", "status", "port"])
      .orderBy("name")
      .execute(),
    db.selectFrom("services").selectAll().execute(),
  ]);

  const uptimes = await containerUptimes(
    services.filter((s) => s.status === "running").map((s) => s.container_name)
  );

  /** Resource usage for one service, whether or not it belongs to a project. */
  function enrich(s: (typeof services)[number]) {
    const stats = s.status === "running" ? containerStats.get(s.container_name) : null;
    const uptime = s.status === "running" ? uptimes.get(s.container_name) : undefined;

    return {
      id: s.id,
      name: s.name,
      type: s.type,
      status: s.status,
      port: s.port,
      uptime,
      memory: stats?.memory,
      cpu: stats?.cpu,
    };
  }

  const projectStats = await Promise.all(
    projects.map(async (p) => {
      let processInfo = null;
      if (p.status === "running" || p.status === "deploying") {
        try {
          processInfo = await processManager.status(p.slug, p.runtime_type);
        } catch {
          /* a driver that cannot answer is reported as no process info */
        }
      }

      const enrichedServices = services.filter((s) => s.project_id === p.id).map(enrich);

      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        runtimeType: p.runtime_type,
        status: p.status,
        port: p.port,
        process: processInfo,
        services: enrichedServices,
      };
    })
  );

  // Services with no project used to be filtered out of this query entirely, so
  // a standalone database had no CPU or memory row anywhere in the panel.
  const standaloneServices = services.filter((s) => !s.project_id).map(enrich);

  return NextResponse.json(
    { server, projects: projectStats, services: standaloneServices },
    { headers: { "Cache-Control": "no-store" } }
  );
}
