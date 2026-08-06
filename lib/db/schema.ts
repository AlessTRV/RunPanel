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
export type RuntimeType = "node" | "static" | "docker" | "custom";
export type TriggerType = "manual" | "webhook";
export type ServiceType = "postgresql" | "mysql" | "redis" | "mongodb";
export type WebhookStatus = "accepted" | "rejected" | "ignored";

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
  /** JSON — holds `containerName` and template-specific fields */
  config: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
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
  webhook_deliveries: WebhookDeliveriesTable;
}
