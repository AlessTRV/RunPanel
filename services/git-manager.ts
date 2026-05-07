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

/** Inject GitHub token into HTTPS URL for private repo access */
function injectToken(repoUrl: string, token: string | null): string {
  if (!token || !repoUrl.startsWith("https://")) return repoUrl;
  // https://github.com/user/repo → https://{token}@github.com/user/repo
  return repoUrl.replace("https://", `https://${token}@`);
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
  const authUrl = injectToken(repoUrl, token);

  await exec("git", ["clone", "--depth", "1", "--branch", branch, authUrl, destDir], {
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

export async function gitPull(
  projectSlug: string,
  branch: string
): Promise<CommitInfo> {
  const repoDir = path.join(config.reposDir, projectSlug);

  // Update remote URL with token (in case it was cloned without one)
  const token = getGitHubToken();
  if (token) {
    try {
      const { stdout: remoteUrl } = await exec("git", ["remote", "get-url", "origin"], { cwd: repoDir });
      const authUrl = injectToken(remoteUrl.trim(), token);
      await exec("git", ["remote", "set-url", "origin", authUrl], { cwd: repoDir });
    } catch { /* ignore */ }
  }

  await exec("git", ["fetch", "origin", branch], {
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
