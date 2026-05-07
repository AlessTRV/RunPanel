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

  // Disk usage (root drive)
  let disk = { total: 0, used: 0, free: 0 };
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    if (os.platform() === "win32") {
      const drive = process.cwd().charAt(0);
      const out = execSync(`powershell -Command "Get-PSDrive ${drive} | Select-Object Used,Free | ConvertTo-Json"`, { encoding: "utf-8" });
      const data = JSON.parse(out);
      disk.used = data.Used || 0;
      disk.free = data.Free || 0;
      disk.total = disk.used + disk.free;
    } else {
      const out = execSync("df -B1 /", { encoding: "utf-8" });
      const parts = out.trim().split("\n")[1].split(/\s+/);
      disk.total = parseInt(parts[1]) || 0;
      disk.used = parseInt(parts[2]) || 0;
      disk.free = parseInt(parts[3]) || 0;
    }
  } catch { /* ignore */ }

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
    disk,
    uptime: os.uptime(),
    platform: os.platform(),
    hostname: os.hostname(),
  });
}
