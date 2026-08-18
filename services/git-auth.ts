import { getSetting } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";

/**
 * Talking to a git remote as somebody, and only to the right somebody.
 *
 * Lifted out of `services/git-manager.ts` when the panel learned to update
 * itself, because that path needs exactly the same three decisions — strip
 * credentials out of a URL, decide whether the token may travel, build the
 * header — on a repository that is not a project. A second copy would be a copy
 * of the *gate*, and the failure mode of getting that gate wrong is posting the
 * operator's GitHub token to somebody else's access log.
 */

/** Strip any embedded credentials from a git HTTPS URL. */
export function cleanRepoUrl(repoUrl: string): string {
  return repoUrl.replace(/https:\/\/[^@]+@/, "https://");
}

/**
 * Whether this remote is one whose answers the panel may trust as GitHub's.
 *
 * Two callers, for two different reasons: `authArgs` because the token may only
 * be sent here, and `gitCheckoutCommit` because GitHub serves any reachable SHA
 * — so from here "not our ref" is a final answer rather than a limitation to
 * work around.
 */
export function isGitHubHost(remoteUrl: string): boolean {
  let host: string;
  try {
    host = new URL(remoteUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "github.com" || host.endsWith(".github.com");
}

/**
 * Build git -c args to pass the GitHub token via an Authorization header
 * (avoids URL-embedded creds, which newer git/curl reject).
 *
 * Gated on the destination, and that is the whole point: `http.extraheader`
 * applies to the command, not to a host. Git sends it to whatever it connects
 * to, so calling this for a URL on someone else's server posts the panel's
 * GitHub token to that server's access log.
 */
export function authArgs(token: string | null, remoteUrl: string): string[] {
  if (!token || !isGitHubHost(remoteUrl)) return [];

  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=Authorization: basic ${encoded}`];
}

/** Load GitHub token from settings (if configured) */
export async function getGitHubToken(): Promise<string | null> {
  try {
    const stored = await getSetting("github_token");
    if (stored) return decrypt(stored);
  } catch { /* not configured, or the secret changed — clone will go anonymous */ }
  return null;
}

/**
 * The environment every git subprocess gets.
 *
 * `GIT_TERMINAL_PROMPT=0` is the one that matters: without it a private remote
 * the panel has no credentials for does not fail, it *blocks*, waiting on a
 * password prompt nobody will ever type — and the command hangs until its
 * timeout instead of saying what is wrong.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}
