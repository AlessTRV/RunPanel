import type { AccessValue, GateValue } from "@/components/AccessSection";

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
  /**
   * The commit this project is held at, or null when it follows its branch.
   *
   * While it is set, Deploy rebuilds this commit and auto-deploy is suspended.
   */
  pinned_sha: string | null;
  pinned_at: string | null;
  /** `owner/name` when the source is a GitHub URL, null for a ZIP or another host. */
  repo: string | null;
  /** Who may reach the published port, and whether the gate enforcing it is up. */
  access: AccessValue;
  gate: GateValue;
}

/** One entry of the branch's timeline, as the version picker renders it. */
export interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

/**
 * Why the list is empty is as much of an answer as the list.
 *
 * `available: false` arrives with a 200 on purpose — `useResource` throws away
 * the body of anything else — so `message` is the sentence to render, already
 * written by the route.
 */
export interface CommitsResponse {
  available: boolean;
  reason?: "no-repo" | "no-token" | "not-found" | "rate-limited";
  message?: string;
  retryAt?: string | null;
  branch: string | null;
  commits: CommitSummary[];
  page: number;
  hasMore: boolean;
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

