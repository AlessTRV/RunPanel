import { Kysely } from "kysely";

/**
 * A native project's checkout, kept somewhere else.
 *
 * A project that runs under PM2 has no container, so it has no binds — what it
 * has is a directory, `data/repos/<slug>`, and no way to put that directory on
 * a different disk.
 *
 *   repo_path   where the checkout was moved to, or NULL for the default.
 *   repo_move   JSON journal of a move in flight, or of the last one.
 *
 * **`repo_path` is for showing and for undoing, not for resolving.** The move
 * leaves a symlink behind at the original location, so every one of the twelve
 * places that build `<reposDir>/<slug>` from a slug keeps working untouched —
 * including the ones that only ever had a slug to work from, and including the
 * absolute paths already stored in `deployments.artifact_dir` and in the static
 * builder's start command. Anything that has to be sure asks the filesystem
 * (`realpath`), not this column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // One statement per column: SQLite accepts a single ADD COLUMN per ALTER.
  await db.schema.alterTable("projects").addColumn("repo_path", "text").execute();
  await db.schema.alterTable("projects").addColumn("repo_move", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("projects").dropColumn("repo_move").execute();
  await db.schema.alterTable("projects").dropColumn("repo_path").execute();
}
