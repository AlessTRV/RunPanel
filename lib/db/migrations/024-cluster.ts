import { Kysely } from "kysely";

/**
 * More than one server.
 *
 * A panel can manage other RunPanel installs ("members") on the same private
 * network. Membership and the replicated user directory need:
 *
 *   cluster_members      every install in the cluster, this one included;
 *                        `status`, `version`, `last_seen_at` and `last_error`
 *                        are local observations and never replicate
 *   cluster_link_tokens  one-time tokens a panel hands out so a fresh install
 *                        can join; only the SHA-256 is stored, like invites
 *   cluster_tombstones   ids of users and members deleted here, so a stale
 *                        copy on another member cannot bring them back
 *   users.updated_at     the merge key when two panels edit the same account;
 *                        NULL on rows older than this migration reads as
 *                        `created_at`
 *
 * The secret and this install's own id live in `settings`, which already holds
 * the panel's other encrypted credentials. A store that never joins anything
 * keeps these tables empty and behaves exactly as before.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("cluster_members")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("url", "text", (col) => col.notNull())
    .addColumn("role", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("version", "text")
    .addColumn("last_seen_at", "text")
    .addColumn("last_error", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("cluster_link_tokens")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("created_by", "text")
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("used_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("cluster_tombstones")
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("id", "text", (col) => col.notNull())
    .addColumn("deleted_at", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("pk_cluster_tombstones", ["kind", "id"])
    .execute();

  await db.schema.alterTable("users").addColumn("updated_at", "text").execute();

  const store = db as unknown as Kysely<MigrationDb>;
  await store
    .updateTable("users")
    .set((eb) => ({ updated_at: eb.ref("created_at") }))
    .where("updated_at", "is", null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("cluster_tombstones").ifExists().execute();
  await db.schema.dropTable("cluster_link_tokens").ifExists().execute();
  await db.schema.dropTable("cluster_members").ifExists().execute();
  // A plain column with no index or constraint: both SQLite (3.35+) and
  // Postgres drop it in place.
  await db.schema.alterTable("users").dropColumn("updated_at").execute();
}

type MigrationDb = {
  users: {
    id: string;
    created_at: string;
    updated_at: string | null;
  };
};
