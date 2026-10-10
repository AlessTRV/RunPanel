import { randomBytes } from "node:crypto";
import { Kysely, sql } from "kysely";

/**
 * Accounts instead of one password.
 *
 * Until now the panel had exactly one credential, `settings.admin_password_hash`,
 * and every session could do everything. This adds:
 *
 *   users             one row per account; exactly one `is_owner`, enforced by
 *                     a partial unique index so two racing setups cannot both win
 *   user_permissions  panel-wide capabilities (backup, updates, users.manage…)
 *   user_grants       access to everything / a folder / a project / a service.
 *                     `scope_id` is '' for `all`, not NULL: a unique index treats
 *                     NULLs as distinct, so NULL would allow duplicate `all` rows
 *   user_invites      one-time links for a first password or a reset; only the
 *                     SHA-256 of the token is stored, like sessions
 *   audit_log         who did what; `user_id` NULL means the panel itself
 *   sessions.user_id  whose session it is
 *
 * The existing password becomes the owner, with no email yet — the login form
 * asks for one on the first sign-in — and every open session is handed to the
 * owner, so updating the panel signs nobody out.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("users")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("email", "text", (col) => col.unique())
    .addColumn("password_hash", "text")
    .addColumn("is_owner", "integer", (col) => col.notNull())
    .addColumn("disabled", "integer", (col) => col.notNull())
    .addColumn("created_by", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("last_login_at", "text")
    .execute();

  await db.schema
    .createIndex("idx_users_single_owner")
    .on("users")
    .column("is_owner")
    .unique()
    .where(sql.ref("is_owner"), "=", 1)
    .execute();

  await db.schema
    .createTable("user_permissions")
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("permission", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("pk_user_permissions", ["user_id", "permission"])
    .execute();

  await db.schema
    .createTable("user_grants")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("scope", "text", (col) => col.notNull())
    .addColumn("scope_id", "text", (col) => col.notNull())
    .addColumn("level", "text", (col) => col.notNull())
    .addColumn("terminal", "integer", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addUniqueConstraint("uq_user_grants_target", ["user_id", "scope", "scope_id"])
    .execute();
  await db.schema.createIndex("idx_user_grants_target").on("user_grants").columns(["scope", "scope_id"]).execute();

  await db.schema
    .createTable("user_invites")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("used_at", "text")
    .addColumn("created_by", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();
  await db.schema.createIndex("idx_user_invites_user").on("user_invites").column("user_id").execute();

  // No foreign key on `user_id`: the log outlives the accounts it mentions.
  await db.schema
    .createTable("audit_log")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("at", "text", (col) => col.notNull())
    .addColumn("user_id", "text")
    .addColumn("category", "text", (col) => col.notNull())
    .addColumn("action", "text", (col) => col.notNull())
    .addColumn("scope", "text")
    .addColumn("scope_id", "text")
    .addColumn("detail", "text")
    .addColumn("ip", "text")
    .execute();
  await db.schema.createIndex("idx_audit_at").on("audit_log").column("at").execute();
  await db.schema.createIndex("idx_audit_user_at").on("audit_log").columns(["user_id", "at"]).execute();
  await db.schema.createIndex("idx_audit_scope_at").on("audit_log").columns(["scope", "scope_id", "at"]).execute();

  await db.schema
    .alterTable("sessions")
    .addColumn("user_id", "text", (col) => col.references("users.id").onDelete("cascade"))
    .execute();
  await db.schema.createIndex("idx_sessions_user").on("sessions").column("user_id").execute();

  // --- the existing password becomes the owner ------------------------------
  const store = db as unknown as Kysely<MigrationDb>;
  const existing = await store
    .selectFrom("settings")
    .select("value")
    .where("key", "=", "admin_password_hash")
    .executeTakeFirst();

  if (existing?.value) {
    const ownerId = randomBytes(10).toString("hex");
    await store
      .insertInto("users")
      .values({
        id: ownerId,
        email: null,
        password_hash: existing.value,
        is_owner: 1,
        disabled: 0,
        created_by: null,
        created_at: new Date().toISOString(),
        last_login_at: null,
      })
      .execute();
    await store.updateTable("sessions").set({ user_id: ownerId }).execute();
    await store.deleteFrom("settings").where("key", "=", "admin_password_hash").execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const store = db as unknown as Kysely<MigrationDb>;
  const owner = await store.selectFrom("users").select("password_hash").where("is_owner", "=", 1).executeTakeFirst();
  if (owner?.password_hash) {
    await store
      .insertInto("settings")
      .values({ key: "admin_password_hash", value: owner.password_hash })
      .execute();
  }

  // SQLite cannot drop a column that carries a foreign key. Sessions are
  // disposable — going back costs a sign-in, not data — so the table is rebuilt
  // in its 003 shape instead.
  await db.schema.dropTable("sessions").execute();
  await db.schema
    .createTable("sessions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("user_agent", "text")
    .addColumn("ip", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("last_seen_at", "text", (col) => col.notNull())
    .addColumn("expires_at", "text", (col) => col.notNull())
    .execute();
  await db.schema.createIndex("idx_sessions_expires").on("sessions").column("expires_at").execute();

  for (const table of ["audit_log", "user_invites", "user_grants", "user_permissions", "users"]) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}

type MigrationDb = {
  settings: { key: string; value: string };
  sessions: { user_id: string | null };
  users: {
    id: string;
    email: string | null;
    password_hash: string | null;
    is_owner: number;
    disabled: number;
    created_by: string | null;
    created_at: string;
    last_login_at: string | null;
  };
};
