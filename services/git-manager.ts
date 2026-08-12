import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { getSetting } from "@/lib/settings";
import { decrypt } from "@/lib/auth";

const exec = promisify(execFile);

export interface CommitInfo {
  sha: string;
  message: string;
}

/** Strip any embedded credentials from a git HTTPS URL */
function cleanRepoUrl(repoUrl: string): string {
  return repoUrl.replace(/https:\/\/[^@]+@/, "https://");
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
function authArgs(token: string | null, remoteUrl: string): string[] {
  if (!token) return [];

  let host: string;
  try {
    host = new URL(remoteUrl).hostname.toLowerCase();
  } catch {
    return [];
  }

  if (host !== "github.com" && !host.endsWith(".github.com")) return [];

  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=Authorization: basic ${encoded}`];
}

/** Load GitHub token from settings (if configured) */
async function getGitHubToken(): Promise<string | null> {
  try {
    const stored = await getSetting("github_token");
    if (stored) return decrypt(stored);
  } catch { /* not configured, or the secret changed — clone will go anonymous */ }
  return null;
}

export async function gitClone(
  repoUrl: string,
  branch: string,
  projectSlug: string
): Promise<void> {
  const destDir = path.join(config.reposDir, projectSlug);

  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  const token = await getGitHubToken();
  const url = cleanRepoUrl(repoUrl);

  await exec("git", [...authArgs(token, url), "clone", "--depth", "1", "--branch", branch, url, destDir], {
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

export async function gitPull(
  projectSlug: string,
  branch: string
): Promise<CommitInfo> {
  const repoDir = path.join(config.reposDir, projectSlug);
  const token = await getGitHubToken();

  // Kept so the fetch below can decide whether the token may go along.
  let originUrl = "";

  // Clean any old embedded-token URL from the remote (legacy repos)
  try {
    const { stdout: remoteUrl } = await exec("git", ["remote", "get-url", "origin"], { cwd: repoDir });
    const cleaned = cleanRepoUrl(remoteUrl.trim());
    originUrl = cleaned;
    if (cleaned !== remoteUrl.trim()) {
      await exec("git", ["remote", "set-url", "origin", cleaned], { cwd: repoDir });
    }
  } catch { /* ignore */ }

  // Explicit refspec, and `--depth 1` again.
  //
  // The clone is shallow and was made with `--branch <x>`, so its fetch refspec
  // only covers that one branch. A plain `git fetch origin <other>` then leaves
  // `origin/<other>` unwritten, and the reset below either fails or — worse —
  // silently keeps deploying the old branch. Naming the destination ref makes
  // switching branches from the UI actually work.
  try {
    await exec(
      "git",
      [
        ...authArgs(token, originUrl),
        "fetch",
        "--depth", "1",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      {
        cwd: repoDir,
        timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/couldn't find remote ref|not found in upstream/i.test(message)) {
      throw new Error(`Il branch "${branch}" non esiste sul remote.`);
    }
    throw err;
  }

  await exec("git", ["reset", "--hard", `refs/remotes/origin/${branch}`], {
    cwd: repoDir,
    timeout: 30_000,
  });

  // Drop files left by the previous branch that the new one does not track,
  // but keep ignored artefacts (node_modules, venv, .next) so a redeploy does
  // not pay to rebuild them from scratch.
  await exec("git", ["clean", "-fd"], { cwd: repoDir, timeout: 60_000 });

  return getLatestCommit(projectSlug);
}

export async function getLatestCommit(projectSlug: string): Promise<CommitInfo> {
  const repoDir = path.join(config.reposDir, projectSlug);

  const { stdout } = await exec(
    "git",
    ["log", "-1", "--format=%H%n%s"],
    { cwd: repoDir }
  );

  const lines = stdout.trim().split("\n");
  return {
    sha: lines[0] || "",
    message: lines[1] || "",
  };
}

export function repoExists(projectSlug: string): boolean {
  return fs.existsSync(path.join(config.reposDir, projectSlug, ".git"));
}

export function getRepoPath(projectSlug: string): string {
  return path.join(config.reposDir, projectSlug);
}

export function verifyWebhookSignature(
  payload: Buffer,
  signature: string,
  secret: string
): boolean {
  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}
