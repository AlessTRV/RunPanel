import { Kysely } from "kysely";

/**
 * Whether a domain's DNS is on the Cloudflare account the panel holds a token
 * for. 0 | 1, kept in step with that account's zones by `syncCloudflare`.
 *
 * Stored rather than asked of Cloudflare each time: applying nginx and renewing
 * certificates must not depend on Cloudflare's API answering. A linked domain
 * gets its certificates through a TXT record and its blocks believe
 * `CF-Connecting-IP` from Cloudflare's ranges.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("domains")
    .addColumn("cloudflare", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("domains").dropColumn("cloudflare").execute();
}
