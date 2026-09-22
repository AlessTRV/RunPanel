import fs from "fs";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { dockerTry, isDockerAvailable } from "../docker/cli";
import { notify } from "./index";
import { backupNeedBytes, backupWontFit, diskLevel, type DiskLevel } from "./messages";

/**
 * The host conditions nothing else in the panel is watching over time.
 *
 * Everything else that gets announced is already detected by somebody: the
 * status sweep knows when a process disappears, the deploy pipeline knows how
 * a deploy ended, the update poller knows when the branch moved. Docker being
 * unreachable and the disk filling up are *states*, not events — the panel
 * reads them on demand when a page asks, and nobody is asking at four in the
 * morning.
 *
 * All of them are edge-triggered. The point is not "the disk is at 8%", which
 * would be true every five minutes for a week; it is "the disk has just crossed
 * into trouble", and later "it has come back out". A monitor that repeats
 * itself gets muted, and a muted monitor is worse than none.
 *
 * The disk is watched in three ways, because it breaks things in three ways:
 * the panel's own data (backups, checkouts, the store), Docker's (images,
 * volumes, build cache) when it lives on another disk, and the room the next
 * scheduled backup will need — which is gone well before the disk looks full.
 */

/**
 * Five minutes. None of these changes faster than that in a way anybody can
 * act on, and they cost a syscall, a `docker info` and one query — cheap, but
 * not so cheap that they belong in the thirty-second sweep.
 */
const TICK_MS = 5 * 60_000;

/** Late enough that Docker has finished its own boot before the first look. */
const FIRST_TICK_DELAY_MS = 90_000;

interface WatchState {
  docker?: boolean;
  /** Per disk, by the scope it is reported under. */
  disk?: Partial<Record<"data" | "docker", DiskLevel>>;
  /** Per policy id: whether the last look said its next backup would not fit. */
  backup?: Record<string, boolean>;
  dockerRoot?: string | null;
}

const globalRef = globalThis as typeof globalThis & {
  __runpanelWatchTimer?: NodeJS.Timeout;
  __runpanelWatchFirstTick?: NodeJS.Timeout;
  /** What the previous tick concluded. `undefined` means never looked. */
  __runpanelWatchState?: WatchState;
};

export function startNotifyWatch(): void {
  if (globalRef.__runpanelWatchTimer) return;

  globalRef.__runpanelWatchTimer = setInterval(() => void watchTick(), TICK_MS);
  globalRef.__runpanelWatchTimer.unref?.();

  globalRef.__runpanelWatchFirstTick = setTimeout(() => void watchTick(), FIRST_TICK_DELAY_MS);
  globalRef.__runpanelWatchFirstTick.unref?.();
}

export interface WatchReading {
  dockerUp: boolean;
  free: number | null;
  total: number | null;
}

interface DiskReading {
  free: number;
  total: number;
  inodesFree: number;
  inodesTotal: number;
  /** The device, to tell whether two paths share a disk. */
  dev: number;
}

function readDisk(dir: string): DiskReading | null {
  try {
    const stat = fs.statfsSync(dir);
    return {
      free: Number(stat.bsize) * Number(stat.bavail),
      total: Number(stat.bsize) * Number(stat.blocks),
      inodesFree: Number(stat.ffree),
      inodesTotal: Number(stat.files),
      dev: fs.statSync(dir).dev,
    };
  } catch {
    return null;
  }
}

/**
 * Where Docker keeps images, volumes and build cache — asked once, since it only
 * changes with the daemon's configuration. Null when it cannot be read from
 * here: a panel inside a container, or Docker Desktop, sees a path that means
 * something else on its own filesystem, and a wrong reading is worse than none.
 */
async function dockerRoot(state: WatchState): Promise<string | null> {
  if (state.dockerRoot !== undefined) return state.dockerRoot;
  const result = await dockerTry(["info", "--format", "{{.DockerRootDir}}"], { timeout: 15_000 });
  const dir = result?.stdout.trim() ?? "";
  const usable = dir.startsWith("/") && fs.existsSync(dir) ? dir : null;
  state.dockerRoot = usable;
  return usable;
}

function inodesShort(reading: DiskReading): { free: number; total: number } | null {
  if (reading.inodesTotal <= 0) return null;
  return reading.inodesFree / reading.inodesTotal < 0.06
    ? { free: reading.inodesFree, total: reading.inodesTotal }
    : null;
}

/**
 * One disk, one transition. Unlike Docker, a disk that is already short when
 * the panel starts is announced on the first look: it is a condition, not a
 * restart in progress, and a panel coming back after an update onto a full
 * disk is exactly the one that must not stay quiet.
 */
function checkDisk(
  scope: "data" | "docker" | "both",
  key: "data" | "docker",
  path: string,
  reading: DiskReading,
  state: WatchState
): void {
  const previous = state.disk?.[key];
  const level = diskLevel(reading, previous);
  state.disk = { ...state.disk, [key]: level };

  const changed = previous === undefined ? level !== "ok" : previous !== level;
  if (!changed) return;

  void notify({
    key: "disk.low",
    up: level === "ok",
    level,
    from: previous,
    scope,
    freeBytes: reading.free,
    totalBytes: reading.total,
    path,
    inodes: inodesShort(reading),
  });
}

/**
 * The room each scheduled backup will need, against what is free where it
 * stages. Estimated from the policy's last archive: a backup that has never
 * run has nothing to estimate from, and says nothing.
 */
async function checkBackups(state: WatchState): Promise<void> {
  const disk = readDisk(config.backupsDir) ?? readDisk(config.dataDir);
  if (!disk) return;

  const db = await getDb();
  const policies = await db
    .selectFrom("backup_policies")
    .select(["id", "name", "next_run_at"])
    .where("enabled", "=", 1)
    .where("cron", "!=", "")
    .execute();

  const warned = { ...(state.backup ?? {}) };
  for (const policy of policies) {
    const last = await db
      .selectFrom("backup_runs")
      .select(["archive_bytes"])
      .where("policy_id", "=", policy.id)
      .where("status", "in", ["success", "partial"])
      .where("archive_bytes", "is not", null)
      .orderBy("started_at", "desc")
      .executeTakeFirst();
    const lastBytes = last?.archive_bytes ?? null;
    if (lastBytes === null) continue;

    const wasWarned = warned[policy.id] === true;
    const short = backupWontFit(disk.free, lastBytes, wasWarned);
    warned[policy.id] = short;
    if (short === wasWarned) continue;

    void notify({
      key: "disk.low",
      up: !short,
      backup: {
        policy: policy.name,
        needBytes: backupNeedBytes(lastBytes),
        lastArchiveBytes: lastBytes,
        nextRunAt: policy.next_run_at,
      },
      freeBytes: disk.free,
      totalBytes: disk.total,
      path: config.backupsDir,
    });
  }
  state.backup = warned;
}

/** Exported so a test can drive a tick without waiting five minutes for one. */
export async function watchTick(): Promise<WatchReading> {
  const state: WatchState = { ...(globalRef.__runpanelWatchState ?? {}) };
  const reading: WatchReading = { dockerUp: true, free: null, total: null };

  try {
    const dockerUp = await isDockerAvailable();
    reading.dockerUp = dockerUp;

    // The first reading only establishes a baseline. A panel that starts while
    // Docker happens to be restarting should not open with an alarm.
    if (state.docker !== undefined && state.docker !== dockerUp) {
      void notify({ key: "docker.down", up: dockerUp });
    }
    state.docker = dockerUp;

    const data = readDisk(config.dataDir);
    const root = dockerUp ? await dockerRoot(state) : null;
    const docker = root ? readDisk(root) : null;
    const shared = Boolean(data && docker && data.dev === docker.dev);

    if (data) {
      reading.free = data.free;
      reading.total = data.total;
      checkDisk(shared ? "both" : "data", "data", config.dataDir, data, state);
    }
    if (docker && root && !shared) checkDisk("docker", "docker", root, docker, state);

    await checkBackups(state);
  } catch (err) {
    // A tick that throws must not take the interval down with it.
    console.error("[notify] Controllo dell'host non riuscito:", err);
  } finally {
    globalRef.__runpanelWatchState = state;
  }

  return reading;
}
