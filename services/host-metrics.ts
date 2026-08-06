import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { isWindows } from "./env-utils";

const exec = promisify(execFile);

export interface HostMetrics {
  cpu: number;
  memory: { total: number; used: number; free: number };
  disk: { total: number; used: number; free: number };
  uptime: number;
  loadAverage: number[];
}

/**
 * Host CPU, measured as a delta.
 *
 * `os.cpus()` returns tick counters accumulated since boot. Averaging them —
 * which is what the old metrics endpoint did — yields the machine's lifetime
 * average, a number that barely moves and tells you nothing about now. The
 * only way to get current usage is to compare two samples.
 */
interface CpuSample {
  idle: number;
  total: number;
  at: number;
}

function sampleCpu(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total, at: Date.now() };
}

let previous: CpuSample | null = null;

async function cpuUsage(): Promise<number> {
  const now = sampleCpu();

  // Too close to the last sample to be meaningful — take a short one instead of
  // reporting noise.
  if (!previous || now.at - previous.at < 200) {
    const first = previous ?? now;
    await new Promise((r) => setTimeout(r, 200));
    const second = sampleCpu();
    previous = second;
    return percentBetween(first, second);
  }

  const usage = percentBetween(previous, now);
  previous = now;
  return usage;
}

function percentBetween(a: CpuSample, b: CpuSample): number {
  const totalDelta = b.total - a.total;
  const idleDelta = b.idle - a.idle;
  if (totalDelta <= 0) return 0;
  const used = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.round(Math.max(0, Math.min(100, used)) * 10) / 10;
}

interface DiskUsage {
  total: number;
  used: number;
  free: number;
}

let diskCache: { value: DiskUsage; at: number } | null = null;
const DISK_TTL_MS = 15_000;

/**
 * Disk usage for the volume RunPanel lives on.
 *
 * Async, and cached: the previous implementation used `execSync`, which blocks
 * the Node event loop for the whole duration of a `df` or a PowerShell start-up
 * on every poll — with the dashboard polling every 5 seconds.
 */
async function diskUsage(): Promise<DiskUsage> {
  if (diskCache && Date.now() - diskCache.at < DISK_TTL_MS) return diskCache.value;

  const empty: DiskUsage = { total: 0, used: 0, free: 0 };
  let value = empty;

  try {
    if (isWindows) {
      const drive = process.cwd().charAt(0);
      const { stdout } = await exec(
        "powershell",
        ["-NoProfile", "-Command", `Get-PSDrive ${drive} | Select-Object Used,Free | ConvertTo-Json`],
        { timeout: 10_000, windowsHide: true }
      );
      const data = JSON.parse(stdout) as { Used?: number; Free?: number };
      const used = data.Used ?? 0;
      const free = data.Free ?? 0;
      value = { used, free, total: used + free };
    } else {
      const { stdout } = await exec("df", ["-B1", "/"], { timeout: 10_000 });
      const parts = stdout.trim().split("\n")[1]?.split(/\s+/) ?? [];
      value = {
        total: Number.parseInt(parts[1], 10) || 0,
        used: Number.parseInt(parts[2], 10) || 0,
        free: Number.parseInt(parts[3], 10) || 0,
      };
    }
  } catch {
    value = empty;
  }

  diskCache = { value, at: Date.now() };
  return value;
}

export async function hostMetrics(): Promise<HostMetrics> {
  const [cpu, disk] = await Promise.all([cpuUsage(), diskUsage()]);
  const total = os.totalmem();
  const free = os.freemem();

  return {
    cpu,
    memory: { total, used: total - free, free },
    disk,
    uptime: os.uptime(),
    loadAverage: os.loadavg(),
  };
}
