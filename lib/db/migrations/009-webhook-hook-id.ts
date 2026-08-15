import { Kysely } from "kysely";

/**
 * Remember which webhook on GitHub is this project's.
 *
 * Registering the hook is idempotent without this column — the panel can list a
 * repository's hooks and recognise its own by the `config.url` it would have
 * written. But that is a request per status read, on a page that polls, against
 * an API with an hourly budget. The id turns the common case into one direct
 * GET.
 *
 * It is a cache and is treated as one: every read verifies it, and a miss falls
 * back to the search by URL, because a hook deleted on github.com leaves the id
 * here pointing at nothing. `text` rather than `integer` — GitHub's ids are
 * int64 and JavaScript numbers are not, so the value is carried as the string
 * it arrived as and never does arithmetic.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("projects").addColumn("github_hook_id", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("projects").dropColumn("github_hook_id").execute();
}
