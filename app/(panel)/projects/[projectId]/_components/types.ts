export interface Project {
  id: string;
  name: string;
  slug: string;
  app_name: string | null;
  source_type: string;
  source_url: string | null;
  source_branch: string;
  runtime_type: string;
  status: string;
  port: number | null;
  auto_deploy: number;
  deploy_count: number;
  last_deploy_at: string | null;
  webhook_secret: string;
  builder_config: string;
}

export interface ProcessInfo {
  running: boolean;
  pid?: number;
  uptime?: number;
  memory?: number;
  cpu?: number;
}

export interface Deployment {
  id: string;
  trigger_type: string;
  commit_sha: string | null;
  commit_message: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
}

export interface EnvVar {
  key: string;
  value: string;
}

export type TabId = "logs" | "deployments" | "env" | "terminal" | "settings";

export function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}g ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

export function fmtDuration(from: string, to: string): string {
  const seconds = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
