import fs from "fs";
import { config } from "@/lib/config";
import { isDockerAvailable } from "../docker/cli";
import { notify } from "./index";
import { diskLow } from "./messages";

/**
 * The two host conditions nothing else in the panel is watching over time.
 *
 * Everything else that gets announced is already detected by somebody: the
 * status sweep knows when a process disappears, the deploy pipeline knows how
 * a deploy ended, the update poller knows when the branch moved. Docker being
 * unreachable and the disk filling up are *states*, not events — the panel
 * reads them on demand when a page asks, and nobody is asking at four in the
 * morning.
 *
 * Both are edge-triggered. The point is not "the disk is at 8%", which would
 * be true every five minutes for a week; it is "the disk has just crossed into
 * trouble", and later "it has come back out". A monitor that repeats itself
 * gets muted, and a muted monitor is worse than none.
 */

/**
 * Five minutes. Neither condition changes faster than that in a way anybody can
 * act on, and both cost a syscall or a `docker version` — cheap, but not so
 * cheap that they belong in the thirty-second sweep.
 */
const TICK_MS = 5 * 60_000;

/** Late enough that Docker has finished its own boot before the first look. */
const FIRST_TICK_DELAY_MS = 90_000;

const globalRef = globalThis as typeof globalThis & {
  __runpanelWatchTimer?: NodeJS.Timeout;
  __runpanelWatchFirstTick?: NodeJS.Timeout;
  /** What the previous tick concluded. `undefined` means never looked. */
  __runpanelWatchState?: { docker?: boolean; diskLow?: boolean };
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

function readDisk(dir: string): { free: number; total: number } | null {
  try {
    const stat = fs.statfsSync(dir);
    return {
      free: Number(stat.bsize) * Number(stat.bavail),
      total: Number(stat.bsize) * Number(stat.blocks),
    };
  } catch {
    return null;
  }
}

/** Exported so a test can drive a tick without waiting five minutes for one. */
export async function watchTick(): Promise<WatchReading> {
  const previous = globalRef.__runpanelWatchState ?? {};
  const reading: WatchReading = { dockerUp: true, free: null, total: null };

  try {
    const dockerUp = await isDockerAvailable();
    reading.dockerUp = dockerUp;

    // The first reading only establishes a baseline. A panel that starts while
    // Docker happens to be restarting should not open with an alarm.
    if (previous.docker !== undefined && previous.docker !== dockerUp) {
      void notify({ key: "docker.down", up: dockerUp });
    }

    const disk = readDisk(config.dataDir);
    if (disk) {
      reading.free = disk.free;
      reading.total = disk.total;

      const low = diskLow(disk.free, disk.total, previous.diskLow);
      if (previous.diskLow !== undefined && previous.diskLow !== low) {
        void notify({
          key: "disk.low",
          up: !low,
          freeBytes: disk.free,
          totalBytes: disk.total,
          path: config.dataDir,
        });
      }
      globalRef.__runpanelWatchState = { docker: dockerUp, diskLow: low };
    } else {
      globalRef.__runpanelWatchState = { ...previous, docker: dockerUp };
    }
  } catch (err) {
    // A tick that throws must not take the interval down with it.
    console.error("[notify] Controllo dell'host non riuscito:", err);
  }

  return reading;
}
