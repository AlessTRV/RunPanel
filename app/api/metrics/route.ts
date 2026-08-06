import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { hostMetrics } from "@/services/host-metrics";
import os from "os";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const metrics = await hostMetrics();
  const cpus = os.cpus();

  return NextResponse.json(
    {
      cpu: {
        usage: metrics.cpu,
        cores: cpus.length,
        model: cpus[0]?.model ?? "Unknown",
        loadAverage: metrics.loadAverage,
      },
      memory: {
        total: metrics.memory.total,
        used: metrics.memory.used,
        available: metrics.memory.free,
      },
      disk: metrics.disk,
      uptime: metrics.uptime,
      platform: os.platform(),
      hostname: os.hostname(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
