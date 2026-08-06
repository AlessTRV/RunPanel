import { dockerStream, isDockerAvailable } from "./cli";

/**
 * A live cache of per-container resource usage, fed by ONE long-running
 * `docker stats` process.
 *
 * What this replaces: every status poll ran `docker stats --no-stream` once per
 * container. Measured on this machine that call costs ~2.5s regardless of how
 * many containers it inspects, and `/api/monitor` fanned it out across every
 * running service on a 3-second interval — so the endpoint could not finish a
 * pass before the next one began.
 *
 * Behaviours confirmed against the Docker CLI rather than assumed:
 *  - a streaming `docker stats` picks up containers that start later, so no
 *    `docker events` subscription is needed to keep the set current;
 *  - each refresh cycle is prefixed with an ANSI cursor-home sequence (stripped
 *    in dockerStream);
 *  - transient rows can carry the literal name "--", which must be ignored or
 *    the cache grows a phantom entry.
 */

export interface ContainerStats {
  name: string;
  /** Percent of one host CPU, as Docker reports it. */
  cpu: number;
  /** Bytes. */
  memory: number;
  memoryPercent: number;
  updatedAt: number;
}

interface RawStatsLine {
  Name?: string;
  CPUPerc?: string;
  MemUsage?: string;
  MemPerc?: string;
}

/** Entries older than this are treated as gone rather than stale-but-true. */
const STALE_AFTER_MS = 15_000;
const RESTART_DELAY_MS = 5_000;

class StatsCollector {
  private cache = new Map<string, ContainerStats>();
  private stop: (() => void) | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private starting = false;

  async ensureStarted(): Promise<void> {
    if (this.stop || this.starting) return;
    this.starting = true;
    try {
      if (!(await isDockerAvailable())) return;
      this.spawn();
    } finally {
      this.starting = false;
    }
  }

  private spawn(): void {
    this.stop = dockerStream(
      ["stats", "--format", "{{json .}}"],
      (line) => this.ingest(line),
      () => {
        // Docker restarted, or the daemon went away. Try again shortly rather
        // than silently serving a cache that will never update again.
        this.stop = null;
        if (this.restartTimer) return;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          void this.ensureStarted();
        }, RESTART_DELAY_MS);
      }
    );
  }

  private ingest(line: string): void {
    if (!line.startsWith("{")) return;

    let raw: RawStatsLine;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }

    const name = raw.Name?.trim();
    // Docker emits placeholder rows for containers mid-transition.
    if (!name || name === "--") return;

    this.cache.set(name, {
      name,
      cpu: parsePercent(raw.CPUPerc),
      memory: parseMemUsage(raw.MemUsage),
      memoryPercent: parsePercent(raw.MemPerc),
      updatedAt: Date.now(),
    });
  }

  get(name: string): ContainerStats | null {
    const entry = this.cache.get(name);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > STALE_AFTER_MS) {
      this.cache.delete(name);
      return null;
    }
    return entry;
  }

  all(): ContainerStats[] {
    const now = Date.now();
    const out: ContainerStats[] = [];
    for (const [name, entry] of this.cache) {
      if (now - entry.updatedAt > STALE_AFTER_MS) this.cache.delete(name);
      else out.push(entry);
    }
    return out;
  }

  shutdown(): void {
    this.stop?.();
    this.stop = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.cache.clear();
  }
}

/** "12.34%" -> 12.34 */
function parsePercent(value: string | undefined): number {
  if (!value) return 0;
  const n = Number.parseFloat(value.replace("%", "").trim());
  return Number.isFinite(n) ? n : 0;
}

/** "764KiB / 15.06GiB" -> bytes for the first figure. */
function parseMemUsage(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(/([\d.]+)\s*([KMGT]?i?B)/i);
  if (!match) return 0;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return 0;

  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1000, KIB: 1024,
    MB: 1000 ** 2, MIB: 1024 ** 2,
    GB: 1000 ** 3, GIB: 1024 ** 3,
    TB: 1000 ** 4, TIB: 1024 ** 4,
  };
  return amount * (multipliers[unit] ?? 1);
}

// Held on globalThis so Next's dev-mode reloads do not leave orphaned
// `docker stats` processes behind on every edit.
const globalRef = globalThis as typeof globalThis & { __runpanelStats?: StatsCollector };
const collector = (globalRef.__runpanelStats ??= new StatsCollector());

export const containerStats = {
  /** Start the collector if it is not already running. Safe to call often. */
  ensureStarted: () => collector.ensureStarted(),
  get: (name: string) => collector.get(name),
  all: () => collector.all(),
  shutdown: () => collector.shutdown(),
};
