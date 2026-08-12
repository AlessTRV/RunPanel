import { getDb } from "@/lib/db";
import type { BackupPoliciesTable, BackupRunsTable } from "@/lib/db/schema";
import { buildDestination } from "./destinations";
import { backupLogPath } from "./paths";
import { removeLogFile } from "../log-file";

/**
 * Keeping the archives a policy asked for and no more.
 *
 * Two rules do most of the work here, and both exist because the obvious
 * implementation is dangerous:
 *
 *  - it runs **after** a successful run, never before one. Making room first
 *    means a full disk can delete a good archive to make space for a backup that
 *    then fails, and you are left with neither;
 *  - the newest successful archive is **never** collected, whatever the numbers
 *    say. `retention_days: 1` typed onto a weekly schedule would otherwise leave
 *    exactly zero backups, and it would look like it was working.
 */

interface Candidate {
  id: string;
  archive_path: string | null;
  archive_bytes: number | null;
  destination_id: string | null;
  started_at: string;
}

export async function applyRetention(policyId: string | null): Promise<number> {
  if (!policyId) return 0;

  const db = await getDb();
  const policy = await db
    .selectFrom("backup_policies")
    .selectAll()
    .where("id", "=", policyId)
    .executeTakeFirst();

  if (!policy) return 0;
  if (!policy.retention_count && !policy.retention_days && !policy.retention_bytes) return 0;

  const runs = await db
    .selectFrom("backup_runs")
    .select(["id", "archive_path", "archive_bytes", "destination_id", "started_at"])
    .where("policy_id", "=", policyId)
    .where("pinned", "=", 0)
    .where("status", "in", ["success", "partial"])
    .orderBy("started_at", "desc")
    .execute();

  const doomed = select(runs, policy);
  if (doomed.length === 0) return 0;

  let removed = 0;
  for (const run of doomed) {
    if (await forget(run)) removed++;
  }
  return removed;
}

/** Newest first in, oldest first out. The head of the list is untouchable. */
function select(runs: Candidate[], policy: BackupPoliciesTable): Candidate[] {
  const keepAlways = runs.slice(0, 1);
  const rest = runs.slice(1);
  const doomed = new Set<Candidate>();

  if (policy.retention_count && policy.retention_count >= 1) {
    for (const run of runs.slice(policy.retention_count)) doomed.add(run);
  }

  if (policy.retention_days) {
    const cutoff = Date.now() - policy.retention_days * 86_400_000;
    for (const run of rest) {
      if (Date.parse(run.started_at) < cutoff) doomed.add(run);
    }
  }

  if (policy.retention_bytes) {
    let total = 0;
    for (const run of runs) {
      total += run.archive_bytes ?? 0;
      if (total > policy.retention_bytes && !keepAlways.includes(run)) doomed.add(run);
    }
  }

  for (const run of keepAlways) doomed.delete(run);
  return [...doomed];
}

/** Remove the archive, then the row. Artifacts cascade; the log goes too. */
async function forget(run: Candidate): Promise<boolean> {
  const db = await getDb();

  if (run.archive_path && run.destination_id) {
    const destination = await db
      .selectFrom("backup_destinations")
      .selectAll()
      .where("id", "=", run.destination_id)
      .executeTakeFirst();

    if (destination) {
      try {
        await buildDestination(destination).remove(run.archive_path);
      } catch (err) {
        // An archive that will not delete is a reason to keep its row: losing
        // the row would leave the file with nothing that knows about it.
        console.error(`[backup] Impossibile rimuovere ${run.archive_path}:`, err);
        return false;
      }
    }
  }

  await db.deleteFrom("backup_runs").where("id", "=", run.id).execute();
  try {
    removeLogFile(backupLogPath(run.id));
  } catch {
    /* an unparseable id has no log to remove */
  }
  return true;
}

/**
 * Archives on disk that no row points at any more — the residue of a database
 * restored from an older snapshot, or of a row deleted by hand.
 *
 * Reported, not deleted. The panel's rule for orphaned Docker resources is that
 * a human decides, and an orphaned archive is if anything more valuable than an
 * orphaned image.
 */
export async function findOrphanArchives(): Promise<string[]> {
  const fs = await import("fs");
  const path = await import("path");
  const { config } = await import("@/lib/config");

  const root = config.backupArchivesDir;
  if (!fs.existsSync(root)) return [];

  const db = await getDb();
  const rows = await db.selectFrom("backup_runs").select("archive_path").execute();
  const known = new Set(rows.map((row) => row.archive_path).filter(Boolean) as string[]);

  const orphans: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".zip")) continue;
      const relative = path.relative(config.backupsDir, full).split(path.sep).join("/");
      if (!known.has(relative)) orphans.push(relative);
    }
  };

  try {
    walk(root);
  } catch {
    /* an unreadable tree is a diagnostics problem, not a sweep failure */
  }
  return orphans;
}

export type { BackupRunsTable };
