import { Kysely } from "kysely";

/**
 * Folders for the Overview.
 *
 * A folder is a label, not a container: it owns nothing, and two nullable
 * columns point at it. `projects.folder_id` is where a project is filed;
 * `services.folder_id` is where a service that belongs to NO project is filed.
 * A service with a `project_id` shows under its project regardless, so the
 * route that links one clears its folder rather than leaving a value nothing
 * will ever read.
 *
 * `on delete set null` is what makes deleting a folder safe: its contents go
 * back to the root rather than away with it. SQLite only honours the clause
 * with foreign keys switched on — which `lib/db/index.ts` does on every
 * connection — and the delete route clears the columns explicitly as well, so
 * the behaviour does not hinge on a pragma.
 *
 * No nesting. Flat folders were the ask, and a `parent_id` that nothing reads
 * is exactly the kind of column migration 018 exists to remove.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("folders")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  // One statement per column: SQLite accepts a single ADD COLUMN per ALTER.
  await db.schema
    .alterTable("projects")
    .addColumn("folder_id", "text", (col) => col.references("folders.id").onDelete("set null"))
    .execute();
  await db.schema
    .alterTable("services")
    .addColumn("folder_id", "text", (col) => col.references("folders.id").onDelete("set null"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("services").dropColumn("folder_id").execute();
  await db.schema.alterTable("projects").dropColumn("folder_id").execute();
  await db.schema.dropTable("folders").ifExists().execute();
}
