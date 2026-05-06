import Database from "better-sqlite3";
import { config, ensureDataDirs } from "./config";
import { runMigrations } from "./db-schema";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  ensureDataDirs();

  _db = new Database(config.dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");

  runMigrations(_db);

  return _db;
}
