import { Kysely } from "kysely";

/**
 * The journal of a project's bind list being applied.
 *
 * The list itself has lived in the deploy contract since long before this —
 * `docker.mounts`, panel-only, already reaching `docker run -v` — so there is
 * nothing to add for it. What was missing is the record of an application in
 * flight: seeding a folder copies real bytes and can run for minutes, and the
 * page has to be able to say so after a reload, while a panel that stopped
 * halfway has to be able to find the project again.
 *
 *   mount_apply   JSON `MountJournal`. NULL when there is nothing to say.
 *
 * One column and not a table, for the same reason the service side has one:
 * `where mount_apply is not null` is a single indexed predicate on both
 * dialects, where the same question inside a JSON blob is a scan and a parse
 * per row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("projects").addColumn("mount_apply", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("projects").dropColumn("mount_apply").execute();
}
