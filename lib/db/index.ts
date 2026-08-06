import fs from "fs";
import path from "path";
import { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import type { Dialect } from "kysely";
import { getEnv } from "../env";
import { ensureDataDirs } from "../config";
import type { Database } from "./schema";
import { StaticMigrationProvider } from "./migrations";
import { nowIso, rowCount } from "./compat";

export type { Database } from "./schema";
export * from "./compat";

/**
 * The pre-Kysely store tracked its own schema in a `_migrations` table and was
 * created by hand-written SQL. Its tables collide with migration 001, so a file
 * from that era cannot simply be opened.
 *
 * It is moved aside rather than deleted — the old rows stay on disk next to the
 * new store if anyone needs to go back for them.
 */
async function archiveLegacySqliteStore(file: string): Promise<void> {
  if (!fs.existsSync(file)) return;

  const { default: SQLite } = await import("better-sqlite3");
  let isLegacy = false;

  // Opened read-write deliberately. A database with a live WAL cannot be read
  // through a readonly handle — SQLite needs to write the -shm index to do it —
  // and this file is about to be renamed anyway. Closing the handle also
  // checkpoints the WAL, so the rename below moves a single tidy file.
  let probe: import("better-sqlite3").Database | null = null;
  try {
    probe = new SQLite(file);
    const hasLegacyTable = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .get();
    const hasKyselyTable = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kysely_migration'")
      .get();
    isLegacy = Boolean(hasLegacyTable) && !hasKyselyTable;
  } catch (err) {
    // Say so rather than silently skipping — a swallowed error here shows up
    // much later as an unexplained "table already exists" during migration.
    console.warn("[RunPanel] Could not inspect the existing store:", err);
    return;
  } finally {
    probe?.close();
  }

  if (!isLegacy) return;

  const archived = `${file}.legacy-${Date.now()}`;
  fs.renameSync(file, archived);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, archived + suffix);
  }

  console.warn(
    `[RunPanel] Found a store from the previous schema and moved it to ${path.basename(archived)}. ` +
      "A fresh store has been created; the old file was not deleted."
  );
}

/**
 * Drivers are imported lazily so that a Postgres deployment never has to load
 * better-sqlite3's native binding, and vice versa.
 */
async function createDialect(): Promise<Dialect> {
  const { db: dbConfig } = getEnv();

  if (dbConfig.driver === "sqlite") {
    ensureDataDirs();
    await archiveLegacySqliteStore(dbConfig.file);

    const { default: SQLite } = await import("better-sqlite3");
    const { SqliteDialect } = await import("kysely");

    const sqlite = new SQLite(dbConfig.file);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");

    return new SqliteDialect({ database: sqlite });
  }

  const { Pool } = await import("pg");
  const { PostgresDialect } = await import("kysely");

  // Only set `ssl` when explicitly asked, so an `sslmode=` already present in a
  // connection string keeps working through pg's own parser.
  const ssl =
    dbConfig.ssl === "disable"
      ? undefined
      : { rejectUnauthorized: dbConfig.ssl === "require" };

  const pool = dbConfig.connectionString
    ? new Pool({ connectionString: dbConfig.connectionString, max: dbConfig.poolMax, ssl })
    : new Pool({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
        max: dbConfig.poolMax,
        ssl,
      });

  return new PostgresDialect({ pool });
}

async function runMigrations(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() });
  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === "Error") {
      console.error(`[RunPanel] Migration failed: ${result.migrationName}`);
    } else if (result.status === "Success") {
      console.log(`[RunPanel] Applied migration ${result.migrationName}`);
    }
  }

  if (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * A deploy that was in flight when the server died leaves rows claiming work is
 * still happening. Nothing will ever finish them, so reconcile at startup.
 */
async function recoverFromCrash(db: Kysely<Database>): Promise<void> {
  const deployments = await db
    .updateTable("deployments")
    .set({
      status: "failed",
      error_message: "Server restarted during deploy",
      finished_at: nowIso(),
    })
    .where("status", "in", ["pending", "building"])
    .executeTakeFirst();

  const projects = await db
    .updateTable("projects")
    .set({ status: "stopped", updated_at: nowIso() })
    .where("status", "=", "deploying")
    .executeTakeFirst();

  const deployCount = rowCount(deployments);
  const projectCount = rowCount(projects);
  if (deployCount > 0 || projectCount > 0) {
    console.log(
      `[RunPanel] Crash recovery: ${deployCount} deployment(s) marked failed, ` +
        `${projectCount} project(s) reset to stopped`
    );
  }
}

async function createDb(): Promise<Kysely<Database>> {
  const dialect = await createDialect();
  const db = new Kysely<Database>({ dialect });

  await runMigrations(db);
  await recoverFromCrash(db);

  const { db: cfg } = getEnv();
  console.log(`[RunPanel] Store ready (${cfg.driver})`);

  return db;
}

/**
 * Held on `globalThis` so Next's dev-mode module reloading does not open a new
 * connection pool (or a second SQLite handle) on every edit.
 */
const globalRef = globalThis as typeof globalThis & {
  __runpanelDb?: Promise<Kysely<Database>>;
};

export function getDb(): Promise<Kysely<Database>> {
  if (!globalRef.__runpanelDb) {
    globalRef.__runpanelDb = createDb().catch((err) => {
      // Never cache a failed init — the next request should retry rather than
      // inherit a permanently rejected promise.
      globalRef.__runpanelDb = undefined;
      throw err;
    });
  }
  return globalRef.__runpanelDb;
}

/** Closes the pool/handle. Used by scripts; the server keeps the singleton. */
export async function closeDb(): Promise<void> {
  const pending = globalRef.__runpanelDb;
  if (!pending) return;
  globalRef.__runpanelDb = undefined;
  const db = await pending;
  await db.destroy();
}
