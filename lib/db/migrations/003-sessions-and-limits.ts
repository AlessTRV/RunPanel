import { Kysely } from "kysely";

/**
 * Real sessions, and a rate limiter that survives a restart.
 *
 * Before this, the whole panel had exactly ONE session: a `session_token` row
 * in the settings table. Logging in from a phone silently signed you out of the
 * desktop, and there was no way to end one session without ending all of them.
 *
 * The login rate limiter lived in a module-level Map, so restarting the server
 * — which an operator does often on a panel like this — reset every counter and
 * handed an attacker a fresh five attempts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("sessions")
    .addColumn("id", "text", (col) => col.primaryKey())
    // The token itself is never stored: only a SHA-256 of it. A leaked database
    // then cannot be replayed as a valid cookie.
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("user_agent", "text")
    .addColumn("ip", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("last_seen_at", "text", (col) => col.notNull())
    .addColumn("expires_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_sessions_expires")
    .on("sessions")
    .column("expires_at")
    .execute();

  await db.schema
    .createTable("rate_limits")
    .addColumn("key", "text", (col) => col.primaryKey())
    .addColumn("count", "integer", (col) => col.notNull())
    .addColumn("reset_at", "text", (col) => col.notNull())
    .execute();

  // The single-session row is obsolete; leaving it would just be a stale
  // credential sitting in the settings table.
  await db.deleteFrom("settings" as never).where("key" as never, "in", [
    "session_token",
    "session_expires",
  ] as never).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("rate_limits").ifExists().execute();
  await db.schema.dropTable("sessions").ifExists().execute();
}
