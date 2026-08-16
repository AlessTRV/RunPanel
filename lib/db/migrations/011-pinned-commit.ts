import { Kysely } from "kysely";

/**
 * A project held at one commit.
 *
 * Until now a project could deploy exactly one thing: the head of its branch.
 * When the commit that just went out is the one that broke the app, the only
 * way back was a revert on GitHub and another push — a fix that needs the
 * repository to cooperate at the moment production is down.
 *
 * A pin is not "the last deploy happened to build an old commit". It is a
 * declaration, and it holds until someone withdraws it: while it is set, every
 * deploy targets that SHA, and auto-deploy is *suspended* rather than quietly
 * overriding it. A push that would have moved the project forward is recorded
 * as ignored, with the reason, instead of undoing the rollback in silence.
 *
 *   pinned_sha   the commit the project is held at; NULL means it follows
 *                `source_branch` as before
 *   pinned_at    when it was pinned, so the panel can say it in one line
 *
 * The pin belongs to a branch, so changing `source_branch` releases it — see
 * the PATCH handler in app/api/projects/[projectId]/route.ts.
 */
const PIN_COLUMNS = [
  ["pinned_sha", "text"],
  ["pinned_at", "text"],
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  // One statement per column: SQLite accepts a single ADD COLUMN per ALTER, so
  // chaining them would compile to valid Postgres and invalid SQLite.
  for (const [column, type] of PIN_COLUMNS) {
    await db.schema.alterTable("projects").addColumn(column, type).execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [column] of [...PIN_COLUMNS].reverse()) {
    await db.schema.alterTable("projects").dropColumn(column).execute();
  }
}
