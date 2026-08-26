import { Kysely } from "kysely";

/**
 * Commands an operator wants run exactly once, at a chosen point of the next
 * deploy.
 *
 * A table, and NOT a field of the deploy contract. The reason is not tidiness:
 * `builder_config` takes part in the merge with the repository's own
 * `runpanel.json` (see `resolveContract`), so a contract field would be
 * arbitrary shell on the host that anybody able to push could set. Keeping it
 * out would mean adding it to `PANEL_ONLY_FIELDS` — which cannot express a
 * top-level key at all, being a list of parent/child pairs — so
 * `stripPanelOnlyFields` would have had to grow too. Out here the answer is
 * structural instead of a deny-list: nothing merges into this table.
 *
 * The lifecycle needs a row of its own for a second reason. A deploy CLAIMS the
 * whole queue in one conditional UPDATE — the same idiom as
 * `deploy-queue.claim()` — and that is what stops a coalesced follow-up from
 * running a command the run before it already took. Inside a JSON blob that is
 * a read-modify-write racing the settings PATCH, which rewrites the whole
 * column.
 *
 * `deployment_id` is ON DELETE SET NULL, deliberately against the cascade used
 * elsewhere: the deployment sweep in `services/docker/gc.ts` really does delete
 * old rows, and it must not erase the record that a command ran. `commit_sha`
 * is denormalised for the same reason `backup_runs` keeps `policy_name`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("one_time_commands")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("project_id", "text", (col) =>
      col.notNull().references("projects.id").onDelete("cascade")
    )
    .addColumn("phase", "text", (col) => col.notNull())
    .addColumn("command", "text", (col) => col.notNull())
    .addColumn("label", "text")
    .addColumn("continue_on_error", "integer", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("position", "integer", (col) => col.notNull())
    .addColumn("attempts", "integer", (col) => col.notNull())
    .addColumn("deployment_id", "text", (col) =>
      col.references("deployments.id").onDelete("set null")
    )
    .addColumn("commit_sha", "text")
    .addColumn("error_message", "text")
    .addColumn("started_at", "text")
    .addColumn("finished_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();

  // The claim, the header's badge and the editor's list all ask the same
  // question: this project, in this state.
  await db.schema
    .createIndex("idx_one_time_project_status")
    .on("one_time_commands")
    .columns(["project_id", "status"])
    .execute();

  // The history list, newest first. A second index rather than a reuse of the
  // one above, because its leading column is not `status`.
  await db.schema
    .createIndex("idx_one_time_project_created")
    .on("one_time_commands")
    .columns(["project_id", "created_at"])
    .execute();

  // The release at the end of a deploy, and the crash sweep at boot, both look
  // rows up by the deploy that holds them.
  await db.schema
    .createIndex("idx_one_time_deployment")
    .on("one_time_commands")
    .column("deployment_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("one_time_commands").ifExists().execute();
}
