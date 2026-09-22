import { Kysely } from "kysely";

/**
 * A name a service can be given after it exists.
 *
 * `name` stays what it has always been — the technical identifier its volumes,
 * its ownership label and its data cleanup are derived from — and becomes, like
 * a project's slug, fixed for life. See `lib/service-name.ts` for why.
 *
 *  - `display_name`: what the panel shows. NULL means `name`.
 *  - `network_aliases`: JSON list of the names the container still answers to
 *    on its project network after it was renamed to follow `display_name`, so
 *    an app started with the old host keeps reaching it until its next deploy.
 *
 * One statement per column: SQLite accepts a single ADD COLUMN per ALTER.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("services").addColumn("display_name", "text").execute();
  await db.schema.alterTable("services").addColumn("network_aliases", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("services").dropColumn("network_aliases").execute();
  await db.schema.alterTable("services").dropColumn("display_name").execute();
}
