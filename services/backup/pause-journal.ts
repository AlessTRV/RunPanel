import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { dockerTry, isDockerAvailable } from "../docker/cli";
import type { PauseJournal } from "./volume-ops";

/**
 * The containers a backup has paused, written down for as long as they are.
 *
 * A panel that dies between `docker pause` and `docker unpause` — out of
 * memory, a reboot of its own service — would leave an application frozen with
 * nothing that ever comes back for it: Docker never unpauses anything by
 * itself, and a restart policy does not apply to a container that is, as far
 * as the engine is concerned, still running. The next boot reads this file and
 * resumes whatever is in it.
 */

interface Entry {
  runId: string;
  ids: string[];
  at: string;
}

function journalPath(): string {
  return path.join(config.backupsDir, "paused-containers.json");
}

function write(entry: Entry): void {
  fs.mkdirSync(path.dirname(journalPath()), { recursive: true });
  fs.writeFileSync(journalPath(), JSON.stringify(entry), { mode: 0o600 });
}

export function pauseJournal(runId: string): PauseJournal {
  return {
    record(ids) {
      write({ runId, ids, at: new Date().toISOString() });
    },
    settle(stillPaused) {
      if (stillPaused.length > 0) write({ runId, ids: stillPaused, at: new Date().toISOString() });
      else fs.rmSync(journalPath(), { force: true });
    },
  };
}

/**
 * Unpause what an interrupted backup left paused. Only ids this panel wrote
 * down, and `unpause` is the only verb: on a container that is not paused, or
 * no longer exists, it fails and changes nothing.
 *
 * Called at boot and again before every backup, since only one runs at a time
 * and a journal found then can only be a previous run's. The file is kept
 * while Docker cannot be asked, so a boot that races the daemon does not
 * forget what it was supposed to resume.
 */
export async function resumeAbandonedPauses(): Promise<number> {
  let entry: Entry;
  try {
    entry = JSON.parse(fs.readFileSync(journalPath(), "utf8")) as Entry;
  } catch {
    return 0;
  }
  if (!(await isDockerAvailable())) return 0;

  let resumed = 0;
  for (const id of Array.isArray(entry.ids) ? entry.ids : []) {
    if (typeof id !== "string" || !/^[a-f0-9]{12,64}$/.test(id)) continue;
    if (await dockerTry(["unpause", id], { timeout: 30_000 })) resumed++;
  }
  fs.rmSync(journalPath(), { force: true });
  return resumed;
}
