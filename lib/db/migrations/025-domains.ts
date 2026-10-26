import { Kysely } from "kysely";

/**
 * Domains and the subdomains projects are served on.
 *
 *   domains        a name this server's nginx answers for under a wildcard
 *                  record, `*.esempio.it`
 *   project_hosts  one name per row, `app.esempio.it` → a project
 *
 * `hostname` is stored whole and unique rather than derived from the pair, so
 * two rows can never claim the same name and the renderer needs no join.
 *
 * A project takes its names with it (`cascade`); a domain does not go while a
 * name still uses it (`restrict` — and the route refuses first, with a reason,
 * because SQLite enforces the clause only with the pragma on).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("domains")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull().unique())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("project_hosts")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("project_id", "text", (col) => col.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("domain_id", "text", (col) => col.notNull().references("domains.id").onDelete("restrict"))
    .addColumn("subdomain", "text", (col) => col.notNull())
    .addColumn("hostname", "text", (col) => col.notNull().unique())
    .addColumn("public_access", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("check_token", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("last_error", "text")
    .addColumn("apply_error", "text")
    .addColumn("cert_expires_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema.createIndex("idx_project_hosts_project").on("project_hosts").column("project_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("project_hosts").ifExists().execute();
  await db.schema.dropTable("domains").ifExists().execute();
}
