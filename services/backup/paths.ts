import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { slugify } from "@/lib/utils";
import { AppendLogFile, isLogId, logPathFor } from "../log-file";

/**
 * Every path a backup touches, and the one check that keeps an id from becoming
 * a path.
 *
 * A run id reaches the filesystem three times — its log, its archive, its
 * download — and the download endpoint is authenticated but reachable. A naive
 * `path.join(dir, id)` with `../../../.secret` normalises into something that
 * looks perfectly reasonable, so the id is validated *before* it is joined, and
 * the result is checked to still be inside the directory it was supposed to be
 * in. Both, because either one alone has been enough to miss a case.
 */

export function assertBackupId(id: string): string {
  if (!isLogId(id)) throw new Error(`Identificativo di backup non valido: ${id}`);
  return id;
}

export function stagingDir(runId: string): string {
  return path.join(config.backupStagingDir, assertBackupId(runId));
}

export function backupLogPath(runId: string): string {
  return logPathFor(path.join(config.logsDir, "backups"), runId);
}

export function restoreLogPath(restoreId: string): string {
  return logPathFor(path.join(config.logsDir, "restores"), restoreId);
}

export function backupLog(runId: string): AppendLogFile {
  return new AppendLogFile(backupLogPath(runId));
}

export function restoreLog(restoreId: string): AppendLogFile {
  return new AppendLogFile(restoreLogPath(restoreId));
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * `archives/<year>/<month>`. Two years of nightlies in one flat directory is a
 * directory nobody can read, and age-based retention would have to stat every
 * entry to find the old ones.
 */
export function archiveDirFor(at: Date): string {
  return path.join(
    config.backupArchivesDir,
    String(at.getUTCFullYear()),
    two(at.getUTCMonth() + 1)
  );
}

/**
 * A name that sorts chronologically, says which policy produced it, and still
 * carries the run id so the file and the row can always be matched up.
 * Stamped in UTC: a filename that shifts by an hour twice a year sorts wrong.
 */
export function archiveFileName(runId: string, policyName: string | null, at: Date): string {
  const stamp =
    `${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}` +
    `-${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}`;
  const label = policyName ? slugify(policyName).slice(0, 32) || "backup" : "manuale";
  return `runpanel-${stamp}-${label}-${assertBackupId(runId)}.zip`;
}

/** Archive paths are stored relative, so moving the data directory is not a migration. */
export function relativeArchivePath(absolutePath: string): string {
  return path.relative(config.backupsDir, absolutePath).split(path.sep).join("/");
}

/**
 * Turn a stored relative path back into an absolute one, refusing anything that
 * escapes. The value comes from our own database, but a database row is exactly
 * the kind of thing that gets edited by hand at three in the morning.
 */
export function resolveArchivePath(relativePath: string): string {
  const root = path.resolve(config.backupsDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Percorso dell'archivio fuori dalla cartella dei backup");
  }
  return resolved;
}

/** Remove a run's staging directory. Called in a `finally`, so it never throws. */
export function clearStaging(runId: string): void {
  try {
    fs.rmSync(stagingDir(runId), { recursive: true, force: true });
  } catch {
    /* a staging directory that will not go is tomorrow's housekeeping problem */
  }
}

/**
 * `.zip.part` files left by a run that died mid-write. They are removed at boot
 * rather than kept: a partial archive has no readable central directory, so
 * there is nothing to recover from it.
 */
export function removePartialArchives(): number {
  const root = config.backupArchivesDir;
  if (!fs.existsSync(root)) return 0;

  let removed = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".zip.part")) {
        try {
          fs.rmSync(full, { force: true });
          removed++;
        } catch {
          /* keep going */
        }
      }
    }
  };

  try {
    walk(root);
  } catch {
    /* an unreadable archive tree is reported by diagnostics, not here */
  }
  return removed;
}
