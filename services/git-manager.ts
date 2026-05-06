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

export async function gitClone(
  repoUrl: string,
  branch: string,
  projectSlug: string
): Promise<void> {
  const destDir = path.join(config.reposDir, projectSlug);

  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  await exec("git", ["clone", "--depth", "1", "--branch", branch, repoUrl, destDir], {
    timeout: 120_000,
  });
}

export async function gitPull(
  projectSlug: string,
  branch: string
): Promise<CommitInfo> {
  const repoDir = path.join(config.reposDir, projectSlug);

  await exec("git", ["fetch", "origin", branch], {
    cwd: repoDir,
    timeout: 60_000,
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
