import { Kysely } from "kysely";

/**
 * Indexes and dead weight on the tables that only ever grow.
 *
 * Three of these tables have no ceiling: a row per deploy, a row per accepted
 * webhook, a row per backup run. Nothing ever deleted from them, and two of the
 * panel's most frequent queries read them whole. On SQLite that matters more
 * than it looks — the driver is synchronous, so a scan that widens with history
 * is time the whole event loop spends waiting.
 *
 * Nothing here deletes anything. Retention is applied by the housekeeping
 * sweep, which can be watched and reasoned about; a migration that silently
 * dropped a year of deploy history would be a surprising thing to have run.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  /**
   * `listRuns()`, `backupOverview()` and the diagnostics card all order by
   * `started_at` across every policy. The existing index is
   * `(policy_id, started_at)`, whose leading column is not in those queries, so
   * each of them sorted the whole table — twice per tick on a page that polls
   * every 5 seconds.
   */
  await db.schema
    .createIndex("idx_backup_runs_started")
    .on("backup_runs")
    .column("started_at")
    .ifNotExists()
    .execute();

  /** `listArtifacts()` filters by run and orders by time; the index covered only the filter. */
  await db.schema
    .createIndex("idx_backup_artifacts_run_created")
    .on("backup_artifacts")
    .columns(["run_id", "created_at"])
    .ifNotExists()
    .execute();

  /**
   * The retention sweep and the crash recovery pass both select deployments by
   * status with no project to narrow them.
   */
  await db.schema
    .createIndex("idx_deployments_status")
    .on("deployments")
    .column("status")
    .ifNotExists()
    .execute();

  /**
   * Two indexes that never earned their write cost, because a composite index
   * already answers everything they could:
   *   `idx_env_vars_project (project_id)` ⊂ `uq_env_vars_project_key (project_id, key)`
   *   `idx_services_project (project_id)` ⊂ `idx_services_project_name (project_id, name)`
   */
  await db.schema.dropIndex("idx_env_vars_project").ifExists().execute();
  await db.schema.dropIndex("idx_services_project").ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("idx_env_vars_project")
    .on("env_vars")
    .column("project_id")
    .ifNotExists()
    .execute();

  await db.schema
    .createIndex("idx_services_project")
    .on("services")
    .column("project_id")
    .ifNotExists()
    .execute();

  await db.schema.dropIndex("idx_deployments_status").ifExists().execute();
  await db.schema.dropIndex("idx_backup_artifacts_run_created").ifExists().execute();
  await db.schema.dropIndex("idx_backup_runs_started").ifExists().execute();
}
