/**
 * The shape of RunPanel's store, shared by both the SQLite and the Postgres
 * dialect. Kysely checks every query against these types, so a column that is
 * renamed here fails the build at each call site instead of at runtime.
 *
 * Conventions that keep the two dialects identical:
 *  - every primary key is a nanoid `text`, never an auto-increment;
 *  - every timestamp is an ISO-8601 UTC string in a `text` column, generated in
 *    application code (`nowIso()`), never by a database default — `datetime('now')`
 *    and `now()` disagree on both spelling and format;
 *  - booleans are stored as `0 | 1` integers, since SQLite has no boolean type
 *    and `pg` would otherwise hand back real booleans for the same column.
 */

export type ProjectStatus = "stopped" | "running" | "deploying" | "error";
export type DeploymentStatus = "pending" | "building" | "running" | "failed" | "superseded";
export type ServiceStatus = "stopped" | "running" | "error";
export type SourceType = "github" | "upload";
export type RuntimeType = "node" | "static" | "docker" | "compose" | "custom";
export type TriggerType = "manual" | "webhook";
export type ServiceType = "postgresql" | "mysql" | "redis" | "mongodb";
export type WebhookStatus = "accepted" | "rejected" | "ignored";

export type BackupDestinationType = "local" | "telegram" | "s3" | "webdav";
export type BackupTrigger = "schedule" | "manual" | "pre-restore";
export type BackupRunStatus = "running" | "success" | "partial" | "failed";
export type BackupArtifactKind =
  | "service-db"
  | "panel-store"
  | "project-config"
  | "project-volume"
  | "project-repo";
export type BackupArtifactStatus = "ok" | "skipped" | "failed";
export type RestoreSource = "catalog" | "upload";
export type RestoreStatus = "running" | "success" | "failed";

export interface SettingsTable {
  key: string;
  value: string;
}

export interface ProjectsTable {
  id: string;
  name: string;
  slug: string;
  app_name: string | null;
  source_type: SourceType;
  source_url: string | null;
  source_branch: string;
  runtime_type: RuntimeType;
  /** JSON — see `BuilderConfig` in lib/types.ts */
  builder_config: string;
  port: number | null;
  status: ProjectStatus;
  /** 0 | 1 */
  auto_deploy: number;
  webhook_secret: string;
  /**
   * 0 | 1 — whether this should be running after a reboot.
   *
   * It is the *declared* state, not a mirror of the current one: pressing Stop
   * does not clear it. A row that asks to autostart and is nonetheless stopped
   * is something the panel reports, not something it quietly rewrites.
   *
   * Nullable because SQLite cannot add a NOT NULL column to a populated table;
   * migration 005 backfills every existing row and readers coalesce.
   */
  autostart: number | null;
  /** Lower starts first. Services are ordered before projects regardless. */
  autostart_order: number | null;
  /** Pause after this one comes up, before starting the next. */
  autostart_delay_s: number | null;
  /** 0 | 1 — block the queue until a readiness probe passes. */
  autostart_wait_healthy: number | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentsTable {
  id: string;
  project_id: string;
  trigger_type: TriggerType;
  commit_sha: string | null;
  commit_message: string | null;
  status: DeploymentStatus;
  /** Build output lives in `data/logs/deployments/<id>.log`, not here. */
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  start_cmd: string | null;
  artifact_dir: string | null;
}

export interface EnvVarsTable {
  id: string;
  project_id: string;
  key: string;
  /** AES-256-GCM ciphertext */
  value: string;
  created_at: string;
}

export interface ServicesTable {
  id: string;
  name: string;
  type: ServiceType;
  version: string;
  status: ServiceStatus;
  container_id: string | null;
  port: number;
  /** AES-256-GCM ciphertext of a JSON credentials object */
  credentials: string;
  /**
   * The Docker container, unique across the panel. A column rather than a value
   * re-derived per call site, because the derivation had a fallback that
   * dropped the project slug and so answered with a DIFFERENT service's
   * container.
   */
  container_name: string;
  /** JSON — holds the attached networks and template-specific fields */
  config: string;
  project_id: string | null;
  /**
   * 0 | 1 — whether this link contributes a connection URL to the project's
   * environment. Explicit, because the previous rule was implicit: inject
   * unless the project happened to define the same key with a truthy value,
   * which no screen could show and no operator could switch off.
   */
  inject_env: number | null;
  /**
   * The variable this link provides. NULL means "derive it from the service
   * type", which is right for the single-database project and wrong the moment
   * there are two of the same type — they would both answer to `DATABASE_URL`.
   */
  env_key: string | null;
  /** 0 | 1 — see `ProjectsTable.autostart`; defaults to on for a database. */
  autostart: number | null;
  autostart_order: number | null;
  autostart_delay_s: number | null;
  autostart_wait_healthy: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * The logical databases inside one service.
 *
 * A service is a database server: one Postgres can hold `app`, `staging` and
 * `analytics` at once. The row is what the panel lists and builds a URL for;
 * the engine remains the authority on what exists.
 */
export interface ServiceDatabasesTable {
  id: string;
  service_id: string;
  name: string;
  created_at: string;
}

/**
 * Where a finished archive is sent. Only `local` is implemented; the type is
 * wider because the column has to survive the day a second one exists.
 *
 * `config` is ciphertext from the start even though a local destination has no
 * secret in it — a token stored later must not need a migration to become
 * encrypted, and a column that is sometimes encrypted is a column nobody can
 * reason about.
 */
export interface BackupDestinationsTable {
  id: string;
  name: string;
  type: BackupDestinationType;
  /** AES-256-GCM ciphertext of a JSON config object */
  config: string;
  /** 0 | 1 */
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface BackupPoliciesTable {
  id: string;
  name: string;
  /** 0 | 1 */
  enabled: number;
  /** A cron expression exactly as typed, aliases included. Empty = manual only. */
  cron: string;
  /** IANA zone. Null falls back to the panel preference, then to UTC — never to the host. */
  timezone: string | null;
  destination_id: string;
  /**
   * JSON — an array of target *selectors*, not ids: `all-services` has to keep
   * meaning "whatever exists when the run starts", which a join table cannot
   * say. The cost is that a deleted project leaves a selector pointing at
   * nothing, so the runner records it as a skipped artifact instead of failing.
   */
  targets: string;
  retention_count: number | null;
  retention_days: number | null;
  retention_bytes: number | null;
  /** 0 | 1 — put `data/.secret` in the archive, making it self-sufficient and dangerous. */
  include_secret_key: number;
  last_run_at: string | null;
  /** The next due instant in UTC. Also the scheduler's claim token. */
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BackupRunsTable {
  id: string;
  /**
   * `set null`, deliberately against the cascade convention used elsewhere: the
   * archive is a file on disk, and cascading the row away would strand it with
   * nothing left to describe or delete it.
   */
  policy_id: string | null;
  /** Kept so history stays readable once the policy is gone. */
  policy_name: string | null;
  trigger: BackupTrigger;
  status: BackupRunStatus;
  destination_id: string | null;
  /** Relative to `config.backupsDir`, so moving the data directory is not a migration. */
  archive_path: string | null;
  archive_bytes: number | null;
  /** sha256 of the archive itself */
  checksum: string | null;
  /** JSON summary, mirrored into the archive and into a sidecar next to it */
  manifest: string | null;
  error_message: string | null;
  /** 0 | 1 — never collected by retention. Safety dumps taken before a restore are. */
  pinned: number;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string;
}

export interface BackupArtifactsTable {
  id: string;
  run_id: string;
  kind: BackupArtifactKind;
  /** No foreign key on purpose: an artifact has to outlive what it was taken from. */
  ref_id: string | null;
  ref_name: string;
  /** Path of the member inside the archive. */
  entry_path: string;
  bytes: number;
  /** sha256 of the *uncompressed* member */
  checksum: string | null;
  status: BackupArtifactStatus;
  error_message: string | null;
  /** JSON — engine and tool versions, helper image used. Restore checks these. */
  meta: string | null;
  created_at: string;
}

/**
 * A restore is not a backup run with a direction flag: half the columns would
 * never apply, and the retention sweeper would have to learn to skip them.
 */
export interface RestoreRunsTable {
  id: string;
  run_id: string | null;
  source: RestoreSource;
  archive_path: string | null;
  /** JSON — the artifact-to-target mapping the operator confirmed. */
  targets: string;
  /** The pre-restore backup taken of exactly what was about to be overwritten. */
  safety_run_id: string | null;
  status: RestoreStatus;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string;
}

export interface WebhookDeliveriesTable {
  id: string;
  project_id: string;
  payload_summary: string | null;
  status: WebhookStatus;
  deployment_id: string | null;
  received_at: string;
}

export interface SessionsTable {
  id: string;
  /** SHA-256 of the cookie value. The token itself is never stored. */
  token_hash: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export interface RateLimitsTable {
  key: string;
  count: number;
  reset_at: string;
}

export interface Database {
  settings: SettingsTable;
  sessions: SessionsTable;
  rate_limits: RateLimitsTable;
  projects: ProjectsTable;
  deployments: DeploymentsTable;
  env_vars: EnvVarsTable;
  services: ServicesTable;
  service_databases: ServiceDatabasesTable;
  webhook_deliveries: WebhookDeliveriesTable;
  backup_destinations: BackupDestinationsTable;
  backup_policies: BackupPoliciesTable;
  backup_runs: BackupRunsTable;
  backup_artifacts: BackupArtifactsTable;
  restore_runs: RestoreRunsTable;
}
