import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { processManager } from "@/services/process-manager";
import { serviceContainerName } from "@/services/service-provisioner";
import { containerStats } from "@/services/docker/stats";
import { dockerTry } from "@/services/docker/cli";
import { hostMetrics } from "@/services/host-metrics";

/**
 * Uptime still needs an inspect per container — it is not in the stats stream —
 * but that call is cheap and bounded, unlike `docker stats --no-stream` which
 * cost ~2.5s each and was previously fanned out across every service on every
 * 3-second poll.
 */
async function containerUptime(containerName: string): Promise<number | undefined> {
  const result = await dockerTry([
    "inspect", containerName, "--format", "{{.State.Running}}|{{.State.StartedAt}}",
  ], { timeout: 5_000 });

  if (!result) return undefined;

  const [running, startedAt] = result.stdout.trim().split("|");
  if (running !== "true" || !startedAt) return undefined;

  const started = new Date(startedAt).getTime();
  return Number.isNaN(started) ? undefined : Math.floor((Date.now() - started) / 1000);
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
    db.selectFrom("services").selectAll().where("project_id", "is not", null).execute(),
  ]);

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

      const projectServices = services.filter((s) => s.project_id === p.id);

      const enrichedServices = await Promise.all(
        projectServices.map(async (s) => {
          let containerName = "";
          try {
            containerName =
              (JSON.parse(s.config || "{}") as { containerName?: string }).containerName ?? "";
          } catch {
            /* fall through to the derived name */
          }
          if (!containerName) containerName = serviceContainerName(s.name);

          const stats = s.status === "running" ? containerStats.get(containerName) : null;
          const uptime = s.status === "running" ? await containerUptime(containerName) : undefined;

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
        })
      );

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

  return NextResponse.json(
    { server, projects: projectStats },
    { headers: { "Cache-Control": "no-store" } }
  );
}
