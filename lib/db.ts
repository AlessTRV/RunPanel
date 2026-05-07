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

  // Recover from crash: reset stuck deployments and projects
  const stuckDeploys = _db.prepare(
    "UPDATE deployments SET status = 'failed', error_message = 'Server crashed during deploy' WHERE status IN ('pending', 'building')"
  ).run();
  const stuckProjects = _db.prepare(
    "UPDATE projects SET status = 'stopped', updated_at = datetime('now') WHERE status = 'deploying'"
  ).run();
  if (stuckDeploys.changes > 0 || stuckProjects.changes > 0) {
    console.log(`[RunPanel] Recovered ${stuckDeploys.changes} stuck deployments, ${stuckProjects.changes} stuck projects from crash`);
  }

  return _db;
}
