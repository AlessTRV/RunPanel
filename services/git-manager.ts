import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "@/lib/config";

const exec = promisify(execFile);

export interface CommitInfo {
  sha: string;
  message: string;
}

/** Strip any embedded credentials from a git HTTPS URL */
function cleanRepoUrl(repoUrl: string): string {
  return repoUrl.replace(/https:\/\/[^@]+@/, "https://");
}

/** Build git -c args to pass GitHub token via Authorization header (avoids URL-embedded creds rejected by newer git/curl) */
function authArgs(token: string | null): string[] {
  if (!token) return [];
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=Authorization: basic ${encoded}`];
}

/** Load GitHub token from DB settings (if configured) */
function getGitHubToken(): string | null {
  try {
    const { getDb } = require("@/lib/db");
    const { decrypt } = require("@/lib/auth");
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'github_token'").get() as { value: string } | undefined;
    if (row?.value) return decrypt(row.value);
  } catch { /* ignore */ }
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

  const token = getGitHubToken();
  const url = cleanRepoUrl(repoUrl);

  await exec("git", [...authArgs(token), "clone", "--depth", "1", "--branch", branch, url, destDir], {
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

export async function gitPull(
  projectSlug: string,
  branch: string
): Promise<CommitInfo> {
  const repoDir = path.join(config.reposDir, projectSlug);
  const token = getGitHubToken();

  // Clean any old embedded-token URL from the remote (legacy repos)
  try {
    const { stdout: remoteUrl } = await exec("git", ["remote", "get-url", "origin"], { cwd: repoDir });
    const cleaned = cleanRepoUrl(remoteUrl.trim());
    if (cleaned !== remoteUrl.trim()) {
      await exec("git", ["remote", "set-url", "origin", cleaned], { cwd: repoDir });
    }
  } catch { /* ignore */ }

  await exec("git", [...authArgs(token), "fetch", "origin", branch], {
    cwd: repoDir,
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  await exec("git", ["reset", "--hard", `origin/${branch}`], {
    cwd: repoDir,
    timeout: 30_000,
  });

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
