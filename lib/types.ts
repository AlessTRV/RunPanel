// Shared database result types — match the SQLite schema exactly

export interface DbProject {
  id: string;
  name: string;
  slug: string;
  source_type: string;
  source_url: string | null;
  source_branch: string;
  runtime_type: string;
  builder_config: string;
  port: number | null;
  status: string;
  auto_deploy: number;
  webhook_secret: string;
  app_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbService {
  id: string;
  name: string;
  type: string;
  version: string;
  status: string;
  container_id: string | null;
  port: number;
  credentials: string;
  config: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbDeployment {
  id: string;
  project_id: string;
  trigger_type: string;
  commit_sha: string | null;
  commit_message: string | null;
  status: string;
  build_log: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  start_cmd: string | null;
  artifact_dir: string | null;
}

export interface DbEnvVar {
  id: number;
  project_id: string;
  key: string;
  value: string;
  created_at: string;
}

export interface BuilderConfig {
  buildCmd?: string;
  startCmd?: string;
  installCmd?: string;
  packageManager?: "auto" | "npm" | "bun" | "pnpm" | "yarn";
  dockerImage?: string;
  dockerTemplate?: string;
  dockerFields?: Record<string, string>;
}

export interface GitHubPushPayload {
  ref?: string;
  head_commit?: { id: string; message: string } | null;
  sender?: { login: string };
}
