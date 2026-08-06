import { Kysely } from "kysely";

/**
 * The full RunPanel schema, created in one shot.
 *
 * Deliberately no CHECK constraints on the status/type columns: SQLite cannot
 * alter a CHECK in place, so widening one means rebuilding the table — which is
 * exactly what silently dropped every foreign key in the previous schema's
 * migration 6. Those enums are enforced by the TypeScript union types in
 * `schema.ts` and by the Zod schemas at the API boundary instead.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("settings")
    .addColumn("key", "text", (col) => col.primaryKey())
    .addColumn("value", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("projects")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("slug", "text", (col) => col.notNull().unique())
    .addColumn("app_name", "text")
    .addColumn("source_type", "text", (col) => col.notNull())
    .addColumn("source_url", "text")
    .addColumn("source_branch", "text", (col) => col.notNull())
    .addColumn("runtime_type", "text", (col) => col.notNull())
    .addColumn("builder_config", "text", (col) => col.notNull())
    .addColumn("port", "integer")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("auto_deploy", "integer", (col) => col.notNull())
    .addColumn("webhook_secret", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("deployments")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("project_id", "text", (col) =>
      col.notNull().references("projects.id").onDelete("cascade")
    )
    .addColumn("trigger_type", "text", (col) => col.notNull())
    .addColumn("commit_sha", "text")
    .addColumn("commit_message", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("build_log", "text", (col) => col.notNull())
    .addColumn("started_at", "text", (col) => col.notNull())
    .addColumn("finished_at", "text")
    .addColumn("error_message", "text")
    .addColumn("start_cmd", "text")
    .addColumn("artifact_dir", "text")
    .execute();

  await db.schema
    .createIndex("idx_deployments_project")
    .on("deployments")
    .columns(["project_id", "started_at"])
    .execute();

  await db.schema
    .createTable("env_vars")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("project_id", "text", (col) =>
      col.notNull().references("projects.id").onDelete("cascade")
    )
    .addColumn("key", "text", (col) => col.notNull())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addUniqueConstraint("uq_env_vars_project_key", ["project_id", "key"])
    .execute();

  await db.schema
    .createIndex("idx_env_vars_project")
    .on("env_vars")
    .column("project_id")
    .execute();

  await db.schema
    .createTable("services")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("version", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("container_id", "text")
    .addColumn("port", "integer", (col) => col.notNull())
    .addColumn("credentials", "text", (col) => col.notNull())
    .addColumn("config", "text", (col) => col.notNull())
    .addColumn("project_id", "text", (col) => col.references("projects.id").onDelete("cascade"))
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_services_project")
    .on("services")
    .column("project_id")
    .execute();

  await db.schema
    .createTable("webhook_deliveries")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("project_id", "text", (col) =>
      col.notNull().references("projects.id").onDelete("cascade")
    )
    .addColumn("payload_summary", "text")
    .addColumn("status", "text", (col) => col.notNull())
    // Intentionally ON DELETE SET NULL: losing the deployment row should not
    // erase the record that a webhook arrived.
    .addColumn("deployment_id", "text", (col) =>
      col.references("deployments.id").onDelete("set null")
    )
    .addColumn("received_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_webhook_project")
    .on("webhook_deliveries")
    .columns(["project_id", "received_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("webhook_deliveries").ifExists().execute();
  await db.schema.dropTable("services").ifExists().execute();
  await db.schema.dropTable("env_vars").ifExists().execute();
  await db.schema.dropTable("deployments").ifExists().execute();
  await db.schema.dropTable("projects").ifExists().execute();
  await db.schema.dropTable("settings").ifExists().execute();
}
