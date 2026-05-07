import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { processManager } from "@/services/process-manager";
import os from "os";

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
    id: string; name: string; type: string; status: string; port: number; project_id: string;
  }[];

  // Gather process stats for each project's app
  const projectStats = await Promise.all(projects.map(async (p) => {
    let processInfo = null;
    if (p.status === "running" || p.status === "deploying") {
      try {
        processInfo = await processManager.status(p.slug, p.runtime_type);
      } catch { /* ignore */ }
    }

    const projectServices = services.filter(s => s.project_id === p.id);

    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      runtimeType: p.runtime_type,
      status: p.status,
      port: p.port,
      process: processInfo,
      services: projectServices.map(s => ({
        id: s.id,
        name: s.name,
        type: s.type,
        status: s.status,
        port: s.port,
      })),
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
