import type { AccessValue, GateValue } from "@/components/AccessSection";
import type { DeployPhase } from "@/lib/deploy-phases";

/**
 * A command waiting to run once, at a chosen point of the next deploy.
 *
 * `blockedReason` is worked out by the server against the project's CURRENT
 * runtime, so it changes when the runtime does — which is the case it exists
 * to describe: a command pinned to the install boundary on a project that has
 * since become a Docker one.
 */
export interface OneTimeCommand {
  id: string;
  phase: DeployPhase;
  command: string;
  label: string | null;
  continueOnError: boolean;
  status: "queued" | "claimed" | "done" | "failed";
  attempts: number;
  commitSha: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  blockedReason: string | null;
}

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
  /** The bind list, as rows — the server splits the `-v` strings, not the browser. */
  mounts: { source: string; target: string; readOnly: boolean; enabled: boolean }[];
  /** Where the checkout really is, asked of the filesystem rather than the column. */
  repo_location: { declared: string; real: string | null };
  repo_path: string | null;
  repoMove: {
    phase: string;
    from: string;
    to: string | null;
    error?: string;
    rolledBack?: boolean;
    leftBehind?: string;
  } | null;
  /**
   * The queue only — the history is fetched by the section that shows it.
   * Here rather than behind its own call because the header has to be able to
   * say, before you press Deploy, that this one will not be an ordinary run.
   */
  oneTimeCommands: OneTimeCommand[];
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

