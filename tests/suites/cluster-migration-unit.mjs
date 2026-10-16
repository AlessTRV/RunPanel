import { createReporter } from "../harness.mjs";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Migration 024 on a store that already has accounts.
 *
 * It must leave existing users with a usable merge key, create the cluster
 * tables with the constraints the merge relies on, and be able to undo itself
 * on SQLite, which cannot drop just any column.
 *
 * Standalone: an in-memory SQLite store, migrations loaded from their files
 * (001, 003, 023 and 024 import only `kysely` and `node:crypto`).
 */
export const meta = { name: "cluster-migration-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("cluster-migration-unit");
  const require = createRequire(join(repoRoot, "package.json"));
  const { Kysely, SqliteDialect } = require("kysely");
  const SQLite = require("better-sqlite3");

  const dir = join(repoRoot, "lib", "db", "migrations");
  const files = readdirSync(dir).filter((f) => /^\d{3}-.*\.ts$/.test(f)).sort();
  const target = files.find((f) => f.startsWith("024-"));
  r.check("migration 024 exists", Boolean(target), files.join(", "));
  if (!target) return r.result();

  const sqlite = new SQLite(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
  const load = (f) => import(pathToFileURL(join(dir, f)).href);

  try {
    for (const f of files.filter((name) => ["001-", "003-", "023-"].some((p) => name.startsWith(p)))) {
      await (await load(f)).up(db);
    }

    const now = "2026-10-15T10:00:00.000Z";
    await db.insertInto("users").values({ id: "u1", email: "a@b.c", password_hash: "$2b$12$h", is_owner: 1, disabled: 0, created_by: null, created_at: now, last_login_at: null }).execute();

    const m024 = await load(target);
    await m024.up(db);

    const u1 = await db.selectFrom("users").selectAll().where("id", "=", "u1").executeTakeFirst();
    r.check("existing users get updated_at = created_at", u1?.updated_at === now, JSON.stringify(u1));

    const tables = sqlite.prepare("select name from sqlite_master where type = 'table' order by name").all().map((x) => x.name);
    r.check("the three cluster tables exist", ["cluster_members", "cluster_link_tokens", "cluster_tombstones"].every((t) => tables.includes(t)), tables.join(", "));

    const memberRow = (id) => ({ id, name: id, url: "http://x:3000", role: "panel", status: "unknown", version: null, last_seen_at: null, last_error: null, created_at: now, updated_at: now });
    await db.insertInto("cluster_members").values(memberRow("m1")).execute();
    let dupMember = null;
    try {
      await db.insertInto("cluster_members").values(memberRow("m1")).execute();
    } catch (err) {
      dupMember = err;
    }
    r.check("member ids are unique", dupMember !== null);

    const tokenRow = (id, hash) => ({ id, token_hash: hash, created_by: "u1", expires_at: now, used_at: null, created_at: now });
    await db.insertInto("cluster_link_tokens").values(tokenRow("t1", "h1")).execute();
    let dupToken = null;
    try {
      await db.insertInto("cluster_link_tokens").values(tokenRow("t2", "h1")).execute();
    } catch (err) {
      dupToken = err;
    }
    r.check("token hashes are unique", dupToken !== null);

    await db.insertInto("cluster_tombstones").values({ kind: "user", id: "x", deleted_at: now }).execute();
    await db.insertInto("cluster_tombstones").values({ kind: "member", id: "x", deleted_at: now }).execute();
    let dupTomb = null;
    try {
      await db.insertInto("cluster_tombstones").values({ kind: "user", id: "x", deleted_at: now }).execute();
    } catch (err) {
      dupTomb = err;
    }
    r.check("a tombstone is unique per kind and id", dupTomb !== null);

    // --- and back ---------------------------------------------------------------
    await m024.down(db);
    const after = sqlite.prepare("select name from sqlite_master where type = 'table' order by name").all().map((x) => x.name);
    r.check("down drops the cluster tables", !after.some((t) => t.startsWith("cluster_")), after.join(", "));
    const cols = sqlite.prepare("pragma table_info(users)").all().map((c) => c.name);
    r.check("down drops users.updated_at", !cols.includes("updated_at"), cols.join(", "));
    const still = await db.selectFrom("users").selectAll().where("id", "=", "u1").executeTakeFirst();
    r.check("the user survives the rollback", still?.password_hash === "$2b$12$h");

    await m024.up(db);
    r.check("up runs again after down", (await db.selectFrom("users").select("updated_at").where("id", "=", "u1").executeTakeFirst())?.updated_at === now);
  } finally {
    await db.destroy();
  }

  return r.result();
}
