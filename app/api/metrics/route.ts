import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import os from "os";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  // Calculate CPU usage from idle times
  const cpuUsage = cpus.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    return acc + ((total - idle) / total) * 100;
  }, 0) / cpus.length;

  return NextResponse.json({
    cpu: {
      usage: Math.round(cpuUsage * 10) / 10,
      cores: cpus.length,
      model: cpus[0]?.model || "Unknown",
    },
    memory: {
      total: totalMem,
      used: totalMem - freeMem,
      available: freeMem,
    },
    uptime: os.uptime(),
    platform: os.platform(),
    hostname: os.hostname(),
  });
}
