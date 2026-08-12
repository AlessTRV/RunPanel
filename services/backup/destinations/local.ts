import fs from "fs";
import path from "path";
import type { Readable } from "stream";
import { config } from "@/lib/config";
import type { BackupDestinationsTable } from "@/lib/db/schema";
import { archiveDirFor, relativeArchivePath, resolveArchivePath } from "../paths";
import type { Destination } from "../types";

/**
 * The archive stays on this machine, under `data/backups/archives`.
 *
 * `put` is a rename, not a copy, which is the reason staging deliberately lives
 * under the data directory too: publishing a finished archive is then atomic and
 * costs nothing, instead of a second full write that can be interrupted halfway.
 */
export function localDestination(row: BackupDestinationsTable): Destination {
  return {
    id: row.id,
    type: "local",
    name: row.name,

    async put(localPath, fileName) {
      const directory = archiveDirFor(new Date());
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, fileName);

      try {
        fs.renameSync(localPath, target);
      } catch (err) {
        // Different filesystems, which happens when the data directory spans
        // mounts. Copy and remove instead of giving up.
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        fs.copyFileSync(localPath, target);
        fs.rmSync(localPath, { force: true });
      }

      return { ref: relativeArchivePath(target), bytes: fs.statSync(target).size };
    },

    async remove(ref) {
      fs.rmSync(resolveArchivePath(ref), { force: true });
    },

    async open(ref): Promise<Readable> {
      const file = resolveArchivePath(ref);
      if (!fs.existsSync(file)) throw new Error(`L'archivio non è più su disco: ${ref}`);
      return fs.createReadStream(file);
    },

    async stat(ref) {
      try {
        const stat = fs.statSync(resolveArchivePath(ref));
        return { bytes: stat.size, exists: true };
      } catch {
        return { bytes: 0, exists: false };
      }
    },

    async test() {
      // Writing a real file, not just checking that the directory exists: a
      // read-only mount and a full disk both look fine until something writes.
      const probe = path.join(config.backupArchivesDir, `.write-test-${process.pid}`);
      try {
        fs.mkdirSync(config.backupArchivesDir, { recursive: true });
        fs.writeFileSync(probe, "ok");
        fs.rmSync(probe, { force: true });
        return { ok: true, message: `Scrittura verificata in ${config.backupArchivesDir}` };
      } catch (err) {
        return {
          ok: false,
          message: `Non riesco a scrivere in ${config.backupArchivesDir}: ${(err as Error).message}`,
        };
      }
    },
  };
}
