import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const exec = promisify(execFile);

/**
 * The panel's own checkout, read and moved.
 *
 * RunPanel is installed by cloning it, so the directory it runs from is a git
 * working tree — the same `process.cwd()` that `services/autostart/probe.ts`
 * writes into `WorkingDirectory=`. That is the whole mechanism: there is no
 * release feed and no update server, just a branch that has moved on.
 *
 * Asking git rather than the GitHub API, deliberately. The update has to go
 * through git anyway, so a check that succeeded where the update would fail
 * would be a lie; git works with any remote rather than only GitHub; and it has
 * no rate limit to stay under.
 *
 * `execFile` and not `runCommand`: no shell is wanted anywhere near a value that
 * came out of a repository, and nothing here produces enough output to need
 * streaming. The one step that does — the build — is not in this file.
 */

/** Written once because the format string and the parser have to agree. */
export const COMMIT_FORMAT = "%H%x1f%an%x1f%aI%x1f%s%x1e";

/**
 * The most commits the panel will carry around.
 *
 * A changelog is read, not audited, and a checkout four hundred commits behind
 * has a problem no list will solve. The count is reported separately and is
 * exact.
 */
export const MAX_COMMITS = 50;

export interface PanelCommit {
  sha: string;
  short: string;
  author: string;
  /** ISO 8601, author date. */
  date: string;
  subject: string;
}

export interface PanelCheckout {
  root: string;
  isRepo: boolean;
  /** Null when HEAD is detached — see `detached`. */
  branch: string | null;
  detached: boolean;
  head: string | null;
  /** Credentials stripped; a raw remote URL must never reach a screen. */
  remote: string | null;
}

/** Where the panel is installed. */
export function panelRoot(): string {
  return process.cwd();
}

// --- Parsing ----------------------------------------------------------------
//
// Kept apart from the running so the unit suite can drive it: these are pure,
// and the suite loads this file directly on a machine that need not have git.

/**
 * `git log` output, one commit per record.
 *
 * The separators are the ASCII unit and record separators rather than a tab or
 * a pipe, and that is not fussiness — a subject in this very repository reads
 * `projects: 🚚 Added moving a native project's checkout to another disk`.
 * Colons, apostrophes and emoji are ordinary here, and any printable delimiter
 * would eventually land inside a message and split it in the wrong place.
 */
export function parseCommitLog(stdout: string): PanelCommit[] {
  const out: PanelCommit[] = [];

  for (const record of stdout.split("\x1e")) {
    // git puts a newline between records, which belongs to neither.
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed) continue;

    const [sha, author, date, ...rest] = trimmed.split("\x1f");
    if (!sha) continue;

    out.push({
      sha,
      short: sha.slice(0, 7),
      author: author ?? "",
      date: date ?? "",
      // Rejoined rather than taken as `[3]`: a subject that somehow contains a
      // unit separator must not quietly lose its tail.
      subject: rest.join("\x1f").trim(),
    });
  }

  return out;
}

/**
 * `git rev-parse --abbrev-ref HEAD`, which answers the literal string `HEAD`
 * when there is no branch to name.
 *
 * A detached HEAD is what a panel checked out by hand looks like, and it has no
 * upstream to compare against — a state to report, not an error to raise.
 */
export function parseBranch(stdout: string): { branch: string | null; detached: boolean } {
  const value = stdout.trim();
  if (!value || value === "HEAD") return { branch: null, detached: true };
  return { branch: value, detached: false };
}

/** `git config --get remote.origin.url`, with any embedded credentials removed. */
export function parseRemoteUrl(stdout: string): string | null {
  const value = stdout.trim();
  if (!value) return null;
  return value.replace(/https:\/\/[^@]+@/, "https://");
}

// --- Running ----------------------------------------------------------------

async function git(
  root: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd: root,
    timeout: opts.timeout ?? 30_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    ...(opts.env ? { env: opts.env } : {}),
  });
  return stdout.toString();
}

/**
 * What the panel's directory is, as far as git is concerned.
 *
 * Never throws. An installation unpacked from a tarball, or one whose `.git`
 * was deleted to save space, is a legitimate way to run RunPanel — it simply
 * cannot be updated from the panel, which is a fact to display rather than a
 * failure to report.
 */
export async function readCheckout(root: string = panelRoot()): Promise<PanelCheckout> {
  const base: PanelCheckout = {
    root,
    isRepo: false,
    branch: null,
    detached: false,
    head: null,
    remote: null,
  };

  if (!fs.existsSync(path.join(root, ".git"))) return base;

  try {
    const inside = (await git(root, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") return base;
  } catch {
    // No git on the PATH, or a directory git refuses to read. Either way the
    // answer to "can this be updated from here" is no.
    return base;
  }

  const [head, branchOut, remoteOut] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]).catch(() => ""),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
    git(root, ["config", "--get", "remote.origin.url"]).catch(() => ""),
  ]);

  const { branch, detached } = parseBranch(branchOut);

  return {
    root,
    isRepo: true,
    branch,
    detached,
    head: head.trim() || null,
    remote: parseRemoteUrl(remoteOut),
  };
}

/**
 * Bring `origin/<branch>` up to date, without touching the working tree.
 *
 * The explicit refspec is the lesson `gitPull()` already learned for projects:
 * a plain `git fetch origin <branch>` can leave `refs/remotes/origin/<branch>`
 * unwritten, and everything downstream then compares against a ref that never
 * moved.
 */
export async function fetchRemote(
  checkout: PanelCheckout,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<void> {
  if (!checkout.branch) throw new Error("Nessun branch da aggiornare: HEAD è staccato");
  await git(
    checkout.root,
    [
      ...args,
      "fetch",
      "origin",
      `+refs/heads/${checkout.branch}:refs/remotes/origin/${checkout.branch}`,
    ],
    { timeout: 120_000, env }
  );
}

/** The SHA `origin/<branch>` points at, as last fetched. */
export async function remoteHead(checkout: PanelCheckout): Promise<string | null> {
  if (!checkout.branch) return null;
  try {
    const out = await git(checkout.root, ["rev-parse", `refs/remotes/origin/${checkout.branch}`]);
    return out.trim() || null;
  } catch {
    // No remote-tracking ref yet: nothing has been fetched on this branch.
    return null;
  }
}

/** How many commits `origin/<branch>` is ahead of HEAD. Exact, uncapped. */
export async function countBehind(checkout: PanelCheckout): Promise<number> {
  if (!checkout.branch) return 0;
  const out = await git(checkout.root, [
    "rev-list",
    "--count",
    `HEAD..refs/remotes/origin/${checkout.branch}`,
  ]);
  const parsed = Number.parseInt(out.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The commits between HEAD and the remote branch, newest first. */
export async function commitsBehind(checkout: PanelCheckout): Promise<PanelCommit[]> {
  if (!checkout.branch) return [];
  const out = await git(checkout.root, [
    "log",
    `--format=${COMMIT_FORMAT}`,
    `--max-count=${MAX_COMMITS}`,
    `HEAD..refs/remotes/origin/${checkout.branch}`,
  ]);
  return parseCommitLog(out);
}

/**
 * What the clean below is about to delete, as a list rather than as a surprise.
 *
 * The update discards local changes on purpose — the panel's own tree is dirty
 * after every single build, because `lib/icons.generated.ts` is tracked and
 * `prebuild` regenerates it — but "on purpose" is only true if it is written
 * somewhere the operator can read afterwards.
 */
export async function wouldClean(checkout: PanelCheckout): Promise<string[]> {
  try {
    const out = await git(checkout.root, ["clean", "-nd", "-e", ".env*"]);
    return out
      .split("\n")
      .map((line) => line.replace(/^Would remove /, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function resetHard(checkout: PanelCheckout, ref: string): Promise<void> {
  await git(checkout.root, ["reset", "--hard", ref], { timeout: 60_000 });
}

/**
 * Drop untracked files, keeping every `.env*`.
 *
 * `-fd` without `-x`, which is the line between an update and a disaster: git
 * leaves ignored files alone, so `data/`, `node_modules/` and `.next` all stay
 * exactly where they are. The extra `-e .env*` covers the gap in `.gitignore` —
 * it lists `.env` and `.env*.local` but not `.env.production`, a file somebody
 * certainly has and nobody would expect an update to delete.
 */
export async function cleanUntracked(checkout: PanelCheckout): Promise<void> {
  await git(checkout.root, ["clean", "-fd", "-e", ".env*"], { timeout: 60_000 });
}
