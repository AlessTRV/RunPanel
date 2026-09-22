import { Kysely } from "kysely";

/**
 * How a project's volumes are backed up: whether the containers writing into a
 * volume are paused while it is copied, a command to run in the stack first,
 * and the paths inside each volume that are left out.
 *
 * One JSON column rather than a table: it is read whole, by one project, once
 * per backup, and a volume listed in it that no longer exists is simply never
 * asked about. NULL means every default — see `lib/backup-settings.ts` — so the
 * existing rows need no backfill.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("projects").addColumn("backup_settings", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("projects").dropColumn("backup_settings").execute();
}
