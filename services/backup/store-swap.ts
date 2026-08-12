import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { getEnv } from "@/lib/env";

/**
 * Put a restored SQLite store into service, at the only moment it is safe to.
 *
 * A file the process has open cannot be replaced underneath it, so the restore
 * step writes `runpanel.restored.db` and leaves a marker. This runs from
 * `instrumentation.ts` **before `getDb()`** — the one instant in the lifetime of
 * the process when nothing holds the database — moves the live file aside, and
 * moves the restored one in.
 *
 * The previous store is kept, never deleted. A restore that turns out to be the
 * wrong archive is a situation where the file you just replaced is the only
 * thing that can save you.
 */

const MARKER = ".restore-pending";
const PENDING = "runpanel.restored.db";

const SIDECARS = ["-wal", "-shm"];

export function applyPendingStoreRestore(): boolean {
  const env = getEnv();
  if (env.db.driver !== "sqlite") return false;

  const marker = path.join(config.dataDir, MARKER);
  const pending = path.join(config.dataDir, PENDING);
  if (!fs.existsSync(marker) || !fs.existsSync(pending)) return false;

  const live = env.db.file;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archived = `${live}.pre-restore-${stamp}`;

  try {
    if (fs.existsSync(live)) {
      fs.renameSync(live, archived);
      // The WAL and the shared-memory index belong to the file we just moved.
      // Leaving them next to the restored database would have SQLite try to
      // replay another database's journal onto it.
      for (const suffix of SIDECARS) {
        if (fs.existsSync(live + suffix)) fs.renameSync(live + suffix, archived + suffix);
      }
    }

    fs.renameSync(pending, live);
    fs.rmSync(marker, { force: true });

    console.log(
      `[RunPanel] Store ripristinato dal backup. Il precedente è stato conservato come ${path.basename(archived)}`
    );
    return true;
  } catch (err) {
    // Leave the marker in place: better to retry at the next boot than to end
    // up with neither database where it should be.
    console.error("[RunPanel] Ripristino dello store non riuscito:", err);
    return false;
  }
}
