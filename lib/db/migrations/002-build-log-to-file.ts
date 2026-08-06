import { Kysely, sql } from "kysely";

/**
 * Build logs move out of the database and onto disk.
 *
 * The column was appended to one line at a time with `build_log || ?`, which
 * rewrites the whole value per line — quadratic in the length of a build's
 * output, and it put megabytes of text nobody queries into every backup.
 *
 * Existing logs are not migrated: they belong to deployments that already
 * finished, and the new file-backed reader simply returns empty for them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("deployments").dropColumn("build_log").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("deployments")
    .addColumn("build_log", "text", (col) => col.notNull().defaultTo(sql`''`))
    .execute();
}
