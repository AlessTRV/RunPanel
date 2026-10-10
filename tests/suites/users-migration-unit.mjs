import { createReporter } from "../harness.mjs";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * From one password to user accounts, on a store that already has data.
 *
 * The operator's panel was set up with a single password in the settings
 * table, and they are signed in right now. Migration 023 has to turn that into
 * the owner account without logging anyone out or losing the password — and a
 * mistake here locks the only person who can fix it out of their own panel.
 *
 * Standalone: an in-memory SQLite store, migrations loaded straight from their
 * files (each one imports only `kysely`).
 */
export const meta = { name: "users-migration-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("users-migration-unit");
  const require = createRequire(join(repoRoot, "package.json"));
  const { Kysely, SqliteDialect, sql } = require("kysely");
  const SQLite = require("better-sqlite3");

  const dir = join(repoRoot, "lib", "db", "migrations");
  const files = readdirSync(dir).filter((f) => /^\d{3}-.*\.ts$/.test(f)).sort();
  const target = files.find((f) => f.startsWith("023-"));
  r.check("migration 023 exists", Boolean(target), files.join(", "));
  if (!target) return r.result();

  const sqlite = new SQLite(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
  const load = (f) => import(pathToFileURL(join(dir, f)).href);

  try {
    // Only the migrations that shape what 023 reads: 001 (settings) and 003
    // (sessions). 007 imports `@/lib/crypto`, which a plain Node import cannot
    // resolve, and nothing 023 touches comes from it.
    for (const f of files.filter((name) => name.startsWith("001-") || name.startsWith("003-"))) {
      await (await load(f)).up(db);
    }

    const now = new Date().toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await db.insertInto("settings").values({ key: "admin_password_hash", value: "$2b$12$existinghash" }).execute();
    await db
      .insertInto("sessions")
      .values({ id: "s1", token_hash: "h1", user_agent: null, ip: null, created_at: now, last_seen_at: now, expires_at: later })
      .execute();

    const m023 = await load(target);
    await m023.up(db);

    const users = await db.selectFrom("users").selectAll().execute();
    r.check("exactly one user is created", users.length === 1, JSON.stringify(users));
    const owner = users[0];
    r.check("it is the owner", owner?.is_owner === 1);
    r.check("it keeps the existing password", owner?.password_hash === "$2b$12$existinghash");
    r.check("its email is not yet known", owner?.email === null);

    const session = await db.selectFrom("sessions").selectAll().where("id", "=", "s1").executeTakeFirst();
    r.check("the open session belongs to the owner", session?.user_id === owner?.id, JSON.stringify(session));

    const leftover = await db.selectFrom("settings").selectAll().where("key", "=", "admin_password_hash").executeTakeFirst();
    r.check("the old password row is gone", leftover === undefined);

    // A second owner would be a second person nobody can demote.
    let secondOwner = null;
    try {
      await db.insertInto("users").values({ id: "u2", email: "x@y.z", password_hash: null, is_owner: 1, disabled: 0, created_by: null, created_at: now, last_login_at: null }).execute();
    } catch (err) {
      secondOwner = err;
    }
    r.check("a second owner is refused", secondOwner !== null);

    await db.insertInto("users").values({ id: "u3", email: "a@b.c", password_hash: null, is_owner: 0, disabled: 0, created_by: owner.id, created_at: now, last_login_at: null }).execute();
    let dupEmail = null;
    try {
      await db.insertInto("users").values({ id: "u4", email: "a@b.c", password_hash: null, is_owner: 0, disabled: 0, created_by: owner.id, created_at: now, last_login_at: null }).execute();
    } catch (err) {
      dupEmail = err;
    }
    r.check("emails are unique", dupEmail !== null);

    const grant = (id) => ({ id, user_id: "u3", scope: "all", scope_id: "", level: "read", terminal: 0, created_at: now });
    await db.insertInto("user_grants").values(grant("g1")).execute();
    let dupGrant = null;
    try {
      await db.insertInto("user_grants").values(grant("g2")).execute();
    } catch (err) {
      dupGrant = err;
    }
    r.check("one grant per user and target", dupGrant !== null);

    await db.insertInto("user_permissions").values({ user_id: "u3", permission: "backup" }).execute();
    await db
      .insertInto("user_invites")
      .values({ id: "i1", user_id: "u3", token_hash: "t1", kind: "invite", expires_at: later, used_at: null, created_by: owner.id, created_at: now })
      .execute();
    await db
      .insertInto("sessions")
      .values({ id: "s3", token_hash: "h3", user_agent: null, ip: null, created_at: now, last_seen_at: now, expires_at: later, user_id: "u3" })
      .execute();
    await db.deleteFrom("users").where("id", "=", "u3").execute();
    const orphans = await Promise.all(
      ["user_grants", "user_permissions", "user_invites", "sessions"].map((t) =>
        db.selectFrom(t).select(sql`count(*)`.as("n")).where("user_id", "=", "u3").executeTakeFirst()
      )
    );
    r.check("deleting a user removes what was theirs", orphans.every((o) => Number(o.n) === 0), JSON.stringify(orphans));

    await db
      .insertInto("audit_log")
      .values({ id: "a1", at: now, user_id: null, category: "security", action: "login", scope: null, scope_id: null, detail: null, ip: null })
      .execute();
    r.check("the audit log accepts a system entry", true);

    await m023.down(db);
    const restored = await db.selectFrom("settings").selectAll().where("key", "=", "admin_password_hash").executeTakeFirst();
    r.check("down restores the password row", restored?.value === "$2b$12$existinghash", JSON.stringify(restored));
  } catch (err) {
    r.check("migration runs", false, err instanceof Error ? err.stack : String(err));
  } finally {
    await db.destroy();
  }

  return r.result();
}
