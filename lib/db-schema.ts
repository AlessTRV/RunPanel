import type Database from "better-sqlite3";

const migrations: string[] = [
  // Migration 1: Initial schema
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL CHECK(source_type IN ('github', 'upload')),
    source_url TEXT,
    source_branch TEXT DEFAULT 'main',
    runtime_type TEXT NOT NULL CHECK(runtime_type IN ('node', 'static', 'docker')),
    builder_config TEXT DEFAULT '{}',
    port INTEGER,
    status TEXT NOT NULL DEFAULT 'stopped' CHECK(status IN ('stopped', 'running', 'deploying', 'error')),
    auto_deploy INTEGER NOT NULL DEFAULT 0,
    webhook_secret TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual', 'webhook')),
    commit_sha TEXT,
    commit_message TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'building', 'running', 'failed', 'superseded')),
    build_log TEXT DEFAULT '',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS env_vars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, key)
  );

  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('postgresql', 'mysql', 'redis', 'mongodb')),
    version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'stopped' CHECK(status IN ('stopped', 'running', 'error')),
    container_id TEXT,
    port INTEGER NOT NULL,
    credentials TEXT NOT NULL DEFAULT '{}',
    config TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    payload_summary TEXT,
    status TEXT NOT NULL CHECK(status IN ('accepted', 'rejected', 'ignored')),
    deployment_id TEXT REFERENCES deployments(id),
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_project ON webhook_deliveries(project_id, received_at DESC);
  `,
  // Migration 2: Store start command and artifact directory for restart support
  `
  ALTER TABLE deployments ADD COLUMN start_cmd TEXT;
  ALTER TABLE deployments ADD COLUMN artifact_dir TEXT;
  `,
  // Migration 3: Link services to projects
  `
  ALTER TABLE services ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_services_project ON services(project_id);
  `,
  // Migration 4: App name separate from project name
  `
  ALTER TABLE projects ADD COLUMN app_name TEXT;
  `,
  // Migration 5: Missing indexes for performance
  `
  CREATE INDEX IF NOT EXISTS idx_env_vars_project ON env_vars(project_id);
  `,
  // Migration 6: Add 'custom' runtime type — recreate projects table with updated CHECK
  `
  CREATE TABLE projects_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL CHECK(source_type IN ('github', 'upload')),
    source_url TEXT,
    source_branch TEXT DEFAULT 'main',
    runtime_type TEXT NOT NULL DEFAULT 'node' CHECK(runtime_type IN ('node', 'static', 'docker', 'custom')),
    builder_config TEXT DEFAULT '{}',
    port INTEGER,
    status TEXT NOT NULL DEFAULT 'stopped' CHECK(status IN ('stopped', 'running', 'deploying', 'error')),
    auto_deploy INTEGER NOT NULL DEFAULT 0,
    webhook_secret TEXT,
    app_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO projects_new SELECT id, name, slug, source_type, source_url, source_branch, runtime_type, builder_config, port, status, auto_deploy, webhook_secret, app_name, created_at, updated_at FROM projects;
  DROP TABLE projects;
  ALTER TABLE projects_new RENAME TO projects;
  `,
  // Migration 7: Manual cascade delete since FKs were lost in migration 6
  // SQLite can't add FK constraints after table creation, so we handle cascade in application code
  // This migration just cleans up any orphaned records from the migration 6 data loss
  `
  DELETE FROM deployments WHERE project_id NOT IN (SELECT id FROM projects);
  DELETE FROM env_vars WHERE project_id NOT IN (SELECT id FROM projects);
  DELETE FROM webhook_deliveries WHERE project_id NOT IN (SELECT id FROM projects);
  DELETE FROM services WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects);
  `,
];

export function runMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const currentVersion = db.prepare(
    "SELECT COALESCE(MAX(version), 0) as v FROM _migrations"
  ).get() as { v: number };

  for (let i = currentVersion.v; i < migrations.length; i++) {
    db.transaction(() => {
      const statements = migrations[i].split(";").filter((s) => s.trim());
      for (const stmt of statements) {
        db.exec(stmt);
      }
      db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(i + 1);
    })();
  }
}
