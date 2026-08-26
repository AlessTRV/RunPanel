import { getSetting } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";

const API = "https://api.github.com";

/**
 * The stored GitHub token, decrypted, or null when no account is connected.
 *
 * A decryption failure means the panel secret changed under a token encrypted
 * with the old one. That is indistinguishable from "not connected" as far as
 * callers are concerned — both mean there is no usable token — so it is
 * reported the same way rather than as a 500.
 */
export async function githubToken(): Promise<string | null> {
  const stored = await getSetting("github_token");
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    return null;
  }
}

export interface GithubRequestInit {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /**
   * Extra headers, for the one caller that needs them: the poller sends
   * `If-None-Match` so an unchanged branch answers 304, which GitHub does not
   * charge against the hourly rate limit.
   */
  headers?: Record<string, string>;
}

/**
 * One request to the GitHub API, with the headers every call needs.
 *
 * `cache: "no-store"` on every verb, not just the reads: a write must never be
 * served from a cache, and the lists this panel reads (repositories, branches,
 * hooks) change on a human timescale — it re-reads them on each visit and does
 * not want a copy from an earlier one.
 */
export function githubRequest(
  path: string,
  token: string,
  init: GithubRequestInit = {}
): Promise<Response> {
  const { method = "GET", body, headers } = init;

  return fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "RunPanel",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });
}

/** The read-only spelling the repo and branch pickers already use. */
export function githubFetch(path: string, token: string): Promise<Response> {
  return githubRequest(path, token);
}

/**
 * `owner/name`, the only shape the GitHub API accepts in a path.
 *
 * Shared with `app/api/github/branches/route.ts`, which validates a
 * caller-supplied value with it. Both uses end up interpolated into an API URL,
 * so a `..` or a slash too many has to be refused rather than encoded.
 */
export const REPO_SLUG_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export interface RepoSlug {
  owner: string;
  repo: string;
  /** `owner/name`, ready to interpolate into an API path. */
  full: string;
}

/**
 * A project's `source_url` read back as `owner/name`.
 *
 * Projects store only the clone URL — the wizard has GitHub's own `full_name`
 * in hand when picking a repository and does not keep it, and the manual-URL
 * path never had one. Anything that talks to the API about a project's
 * repository has to recover the pair from the URL, so it is recovered in one
 * place.
 *
 * Returns null rather than throwing: "this project is not a GitHub repository"
 * is a normal state for an uploaded ZIP, and every caller has something useful
 * to say about it.
 */
export function parseRepoSlug(sourceUrl: string | null | undefined): RepoSlug | null {
  if (!sourceUrl) return null;

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  const full = `${owner}/${repo}`;

  return REPO_SLUG_PATTERN.test(full) ? { owner, repo, full } : null;
}

/**
 * The slice of a GitHub push payload the webhook actually reads.
 *
 * Moved here from `lib/types.ts`, which was deleted: the other five types in
 * that file were unreferenced and had drifted from the real schema — one of
 * them still described a column removed in migration 002 — while a comment on
 * `projects.builder_config` pointed readers at it as the authority. The shape
 * of `builder_config` is `deployContractSchema` in lib/deploy-contract.ts.
 */
export interface GitHubPushPayload {
  ref?: string;
  head_commit?: { id: string; message: string } | null;
  sender?: { login: string };
}
