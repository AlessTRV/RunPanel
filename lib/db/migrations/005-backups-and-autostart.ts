import { Kysely } from "kysely";

/**
 * Two subsystems that both need to survive a reboot.
 *
 * **Backups** get four tables rather than one: a destination is configuration
 * that outlives every run, a policy is what to take and when, a run is one
 * attempt, and an artifact is what that attempt managed to capture for a single
 * target. Flattening them would make the common question — "which of last
 * night's twelve targets failed?" — unanswerable without parsing a blob.
 *
 * **Autostart** gets columns on `projects` and `services` instead of a table of
 * its own. It is one boolean and three knobs per row, always read together with
 * the row, and a side table would mean an outer join on every listing plus a
 * class of bug where the two disagree.
 *
 * The projects backfill reads `status`, which is only trustworthy here because
 * `createDb()` runs migrations *before* `recoverFromCrash()` — at this point the
 * column still says what was running when the process died, which is exactly
 * the state the operator would have chosen by hand.
 */

type MigrationDb = Kysely<{
  projects: {
    id: string;
    status: string;
    autostart: number | null;
    autostart_order: number | null;
    autostart_delay_s: number | null;
    autostart_wait_healthy: number | null;
  };
  services: {
    id: string;
    autostart: number | null;
    autostart_order: number | null;
    autostart_delay_s: number | null;
    autostart_wait_healthy: number | null;
  };
}>;

const AUTOSTART_COLUMNS = [
  "autostart",
  "autostart_order",
  "autostart_delay_s",
  "autostart_wait_healthy",
] as const;

/**
 * Services come up before projects at boot, and the numbers say so on their own
 * so a reordered list never has to be renumbered across both tables.
 */
const SERVICE_ORDER = 50;
const PROJECT_ORDER = 100;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("backup_destinations")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("config", "text", (col) => col.notNull())
    .addColumn("is_default", "integer", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_backup_destinations_name")
    .unique()
    .on("backup_destinations")
    .column("name")
    .execute();

  await db.schema
    .createTable("backup_policies")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("enabled", "integer", (col) => col.notNull())
    .addColumn("cron", "text", (col) => col.notNull())
    .addColumn("timezone", "text")
    .addColumn("destination_id", "text", (col) =>
      col.notNull().references("backup_destinations.id").onDelete("cascade")
    )
    .addColumn("targets", "text", (col) => col.notNull())
    .addColumn("retention_count", "integer")
    .addColumn("retention_days", "integer")
    .addColumn("retention_bytes", "integer")
    .addColumn("include_secret_key", "integer", (col) => col.notNull())
    .addColumn("last_run_at", "text")
    .addColumn("next_run_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_backup_policies_due")
    .on("backup_policies")
    .columns(["enabled", "next_run_at"])
    .execute();

  // `set null` on both parents, deliberately unlike everywhere else in this
  // schema: the row describes a file on disk. Cascading it away on a policy
  // delete would leave the archive with nothing that knows its name, its size
  // or that it may be deleted — the same shape of leak as an unlabelled volume.
  await db.schema
    .createTable("backup_runs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("policy_id", "text", (col) =>
      col.references("backup_policies.id").onDelete("set null")
    )
    .addColumn("policy_name", "text")
    .addColumn("trigger", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("destination_id", "text", (col) =>
      col.references("backup_destinations.id").onDelete("set null")
    )
    .addColumn("archive_path", "text")
    .addColumn("archive_bytes", "integer")
    .addColumn("checksum", "text")
    .addColumn("manifest", "text")
    .addColumn("error_message", "text")
    .addColumn("pinned", "integer", (col) => col.notNull())
    .addColumn("started_at", "text", (col) => col.notNull())
    .addColumn("finished_at", "text")
    .addColumn("heartbeat_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_backup_runs_policy")
    .on("backup_runs")
    .columns(["policy_id", "started_at"])
    .execute();

  await db.schema
    .createIndex("idx_backup_runs_status")
    .on("backup_runs")
    .column("status")
    .execute();

  await db.schema
    .createTable("backup_artifacts")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("run_id", "text", (col) =>
      col.notNull().references("backup_runs.id").onDelete("cascade")
    )
    .addColumn("kind", "text", (col) => col.notNull())
    // No reference: the service or project it came from may be long gone, and
    // an artifact that vanishes with its source is an artifact you cannot
    // restore from precisely when you need to.
    .addColumn("ref_id", "text")
    .addColumn("ref_name", "text", (col) => col.notNull())
    .addColumn("entry_path", "text", (col) => col.notNull())
    .addColumn("bytes", "integer", (col) => col.notNull())
    .addColumn("checksum", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("error_message", "text")
    .addColumn("meta", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_backup_artifacts_run")
    .on("backup_artifacts")
    .column("run_id")
    .execute();

  await db.schema
    .createTable("restore_runs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("run_id", "text", (col) => col.references("backup_runs.id").onDelete("set null"))
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("archive_path", "text")
    .addColumn("targets", "text", (col) => col.notNull())
    .addColumn("safety_run_id", "text", (col) =>
      col.references("backup_runs.id").onDelete("set null")
    )
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("error_message", "text")
    .addColumn("started_at", "text", (col) => col.notNull())
    .addColumn("finished_at", "text")
    .addColumn("heartbeat_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_restore_runs_started")
    .on("restore_runs")
    .column("started_at")
    .execute();

  // One statement per column: SQLite accepts a single ADD COLUMN per ALTER, so
  // chaining them would compile to valid Postgres and invalid SQLite.
  for (const table of ["projects", "services"] as const) {
    for (const column of AUTOSTART_COLUMNS) {
      await db.schema.alterTable(table).addColumn(column, "integer").execute();
    }
  }

  const typed = db as unknown as MigrationDb;

  // A database that does not come back is worse than an app that does not, and
  // an app whose database is missing fails in a way that looks like a bug in
  // the app. So services default to on, and wait for a readiness probe.
  await typed
    .updateTable("services")
    .set({
      autostart: 1,
      autostart_order: SERVICE_ORDER,
      autostart_delay_s: 0,
      autostart_wait_healthy: 1,
    })
    .execute();

  await typed
    .updateTable("projects")
    .set({
      autostart_order: PROJECT_ORDER,
      autostart_delay_s: 0,
      autostart_wait_healthy: 0,
    })
    .execute();

  await typed
    .updateTable("projects")
    .set({ autostart: 1 })
    .where("status", "=", "running")
    .execute();

  await typed
    .updateTable("projects")
    .set({ autostart: 0 })
    .where("status", "!=", "running")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ["projects", "services"] as const) {
    for (const column of AUTOSTART_COLUMNS) {
      await db.schema.alterTable(table).dropColumn(column).execute();
    }
  }

  await db.schema.dropTable("restore_runs").ifExists().execute();
  await db.schema.dropTable("backup_artifacts").ifExists().execute();
  await db.schema.dropTable("backup_runs").ifExists().execute();
  await db.schema.dropTable("backup_policies").ifExists().execute();
  await db.schema.dropTable("backup_destinations").ifExists().execute();
}
