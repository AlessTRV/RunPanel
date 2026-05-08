import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { processManager } from "@/services/process-manager";
import { serviceContainerName } from "@/services/service-provisioner";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";

const exec = promisify(execFile);

/** Get uptime (seconds) and stats for a Docker service container */
async function getServiceStats(containerName: string): Promise<{
  uptime?: number;
  memory?: number;
  cpu?: number;
} | null> {
  try {
    const { stdout } = await exec("docker", [
      "inspect", containerName,
      "--format", "{{.State.Running}}|{{.State.StartedAt}}",
    ], { timeout: 5_000 });

    const [running, startedAt] = stdout.trim().split("|");
    if (running !== "true") return null;

    let uptime: number | undefined;
    if (startedAt) {
      const started = new Date(startedAt).getTime();
      if (!isNaN(started)) uptime = Math.floor((Date.now() - started) / 1000);
    }

    // Try to get memory/cpu stats
    try {
      const { stdout: stats } = await exec("docker", [
        "stats", containerName, "--no-stream", "--format", "{{.MemUsage}}|{{.CPUPerc}}",
      ], { timeout: 5_000 });
      const [memStr, cpuStr] = stats.trim().split("|");
      const memMatch = memStr?.match(/([\d.]+)([MG]iB)/);
      const memory = memMatch
        ? parseFloat(memMatch[1]) * (memMatch[2] === "GiB" ? 1024 * 1024 * 1024 : 1024 * 1024)
        : undefined;
      const cpu = cpuStr ? parseFloat(cpuStr) : undefined;
      return { uptime, memory, cpu };
    } catch {
      return { uptime };
    }
  } catch {
    return null;
  }
}

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const db = getDb();

  // Server metrics
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpuUsage = cpus.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    return acc + ((total - idle) / total) * 100;
  }, 0) / cpus.length;

  // All projects with services
  const projects = db.prepare(`
    SELECT p.id, p.name, p.slug, p.runtime_type, p.status, p.port
    FROM projects p ORDER BY p.name
  `).all() as { id: string; name: string; slug: string; runtime_type: string; status: string; port: number | null }[];

  const services = db.prepare("SELECT * FROM services WHERE project_id IS NOT NULL").all() as {
    id: string; name: string; type: string; status: string; port: number; project_id: string; config: string;
  }[];

  // Gather process stats for projects and services in parallel
  const projectStats = await Promise.all(projects.map(async (p) => {
    let processInfo = null;
    if (p.status === "running" || p.status === "deploying") {
      try {
        processInfo = await processManager.status(p.slug, p.runtime_type);
      } catch { /* ignore */ }
    }

    const projectServices = services.filter(s => s.project_id === p.id);

    // Fetch stats for each service container in parallel
    const enrichedServices = await Promise.all(projectServices.map(async (s) => {
      let cn: string;
      try { const cfg = JSON.parse(s.config || "{}"); cn = cfg.containerName; } catch { cn = ""; }
      if (!cn) cn = serviceContainerName(s.name);
      const stats = s.status === "running" ? await getServiceStats(cn) : null;
      return {
        id: s.id,
        name: s.name,
        type: s.type,
        status: s.status,
        port: s.port,
        uptime: stats?.uptime,
        memory: stats?.memory,
        cpu: stats?.cpu,
      };
    }));

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
  }));

  return NextResponse.json({
    server: {
      cpu: Math.round(cpuUsage * 10) / 10,
      memory: { total: totalMem, used: totalMem - freeMem },
      uptime: os.uptime(),
    },
    projects: projectStats,
  });
}
