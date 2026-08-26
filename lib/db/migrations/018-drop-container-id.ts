import { Kysely } from "kysely";

/**
 * `services.container_id` goes.
 *
 * It was written on every service create and on every recreate, and read by
 * nothing: a repo-wide search for the name finds the two writes, the original
 * `addColumn`, and the type declaration. Migration 004 introduced
 * `container_name` — unique across the panel, and what all forty-odd real call
 * sites use — and this one was simply never removed.
 *
 * Dropped rather than left dead for the reason migration 013 gives about the
 * columns it retired: a column nothing reads is a column the next person has to
 * work out the meaning of, and this one additionally goes stale in place, so it
 * reads like an answer while being an old one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("services").dropColumn("container_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("services").addColumn("container_id", "text").execute();
}
