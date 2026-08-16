import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { getSetting } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { isCommitSha } from "@/lib/git-ref";

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
 * Whether this remote is one whose answers the panel may trust as GitHub's.
 *
 * Two callers, for two different reasons: `authArgs` because the token may only
 * be sent here, and `gitCheckoutCommit` because GitHub serves any reachable SHA
 * — so from here "not our ref" is a final answer rather than a limitation to
 * work around.
 */
function isGitHubHost(remoteUrl: string): boolean {
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
function authArgs(token: string | null, remoteUrl: string): string[] {
  if (!token || !isGitHubHost(remoteUrl)) return [];

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

/**
 * The origin URL, with the credentials old clones used to carry stripped out.
 *
 * Returned as well as rewritten because `authArgs` has to decide on the real
 * URL: the token goes to github.com and to nobody else.
 */
async function cleanOrigin(repoDir: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["remote", "get-url", "origin"], { cwd: repoDir });
    const current = stdout.trim();
    const cleaned = cleanRepoUrl(current);
    if (cleaned !== current) {
      await exec("git", ["remote", "set-url", "origin", cleaned], { cwd: repoDir });
    }
    return cleaned;
  } catch {
    return "";
  }
}

export async function gitPull(
  projectSlug: string,
  branch: string
): Promise<CommitInfo> {
  const repoDir = path.join(config.reposDir, projectSlug);
  const token = await getGitHubToken();

  // Kept so the fetch below can decide whether the token may go along.
  const originUrl = await cleanOrigin(repoDir);

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

  // Recovers from a detached HEAD without being told about one, which is what a
  // pinned deploy leaves behind: with HEAD detached this MOVES HEAD rather than
  // looking for a branch to move, so there is nothing extra to do here. Do not
  // "fix" it with a `git checkout -B <branch>` — that fails on untracked files
  // colliding with tracked ones, where `reset --hard` simply overwrites them.
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

export interface CheckoutOptions {
  /** Only needed when the repository is not on disk yet. */
  repoUrl?: string | null;
  /** The fallback below can take tens of seconds: whoever is watching should know. */
  onLog?: (line: string) => void;
}

/**
 * Put the working tree on one specific commit.
 *
 * The clone is `--depth 1`, so the local repository knows exactly one commit and
 * a rollback cannot be a local operation — the object has to come back from the
 * remote. Two ways to ask for it, in order of what they cost:
 *
 *  1. `git fetch --depth 1 origin <sha>`. GitHub enables `allowAnySHA1InWant`,
 *     and this is the same call `actions/checkout` makes, so on the one host the
 *     panel gates its token for it is the well-trodden path. It downloads one
 *     commit regardless of how far back it is.
 *  2. Deepening the branch until the commit is inside the truncated history.
 *     Gitea, older GitLab and a plain `git daemon` refuse (1), and a commit
 *     eighty pushes back is a real amount of history — hence the steps rather
 *     than jumping straight to `--unshallow`.
 *
 * (2) is skipped when github.com has already said it does not have the object:
 * there, (1) is authoritative, and the escalation would only spend minutes
 * arriving at the same answer.
 */
export async function gitCheckoutCommit(
  projectSlug: string,
  branch: string,
  sha: string,
  opts: CheckoutOptions = {}
): Promise<CommitInfo> {
  const target = sha.trim().toLowerCase();

  // Before anything touches `execFile`. Git reads an argument beginning with a
  // hyphen as an option, so `--upload-pack=<cmd>` where a SHA was expected runs
  // a command on this machine — and there is no shell to escape, because there
  // is no shell. The character set is the defence.
  if (!isCommitSha(target)) {
    throw new Error("Commit non valido: serve lo SHA completo, 40 caratteri esadecimali.");
  }

  const short = target.slice(0, 7);
  const log = opts.onLog ?? (() => {});

  if (!repoExists(projectSlug)) {
    if (!opts.repoUrl) {
      throw new Error("Nessun repository sul disco: collega un repository GitHub e fai un deploy.");
    }
    log(`Cloning ${opts.repoUrl}...`);
    await gitClone(opts.repoUrl, branch, projectSlug);
  }

  const repoDir = path.join(config.reposDir, projectSlug);
  const token = await getGitHubToken();
  const originUrl = await cleanOrigin(repoDir);
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  /**
   * Whether the object is really here. A fetch that exits 0 having sent nothing
   * useful is possible, so this asserts rather than assumes.
   *
   * `^{commit}` and not the bare SHA: an annotated tag has an object id of its
   * own, and `cat-file -e <tag>` would say yes about something `reset --hard`
   * cannot be pointed at.
   */
  const hasCommit = async (): Promise<boolean> => {
    try {
      await exec("git", ["cat-file", "-e", `${target}^{commit}`], { cwd: repoDir, timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  };

  const unreachable = () =>
    new Error(
      `Il commit ${short} non è raggiungibile da "${branch}". ` +
        `Può appartenere a un altro branch, oppure essere stato rimosso dal remote.`
    );

  let refused = false;

  try {
    // No destination refspec: this writes FETCH_HEAD, and the object stays
    // around unreferenced until the reset below lands on it. Nothing runs a gc
    // in between.
    await exec("git", [...authArgs(token, originUrl), "fetch", "--depth", "1", "origin", target], {
      cwd: repoDir,
      timeout: 120_000,
      env: gitEnv,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    /*
      Three different answers arrive as one failure, and they want three
      different things.

      "Server does not allow request for unadvertised object" is a remote that
      will not hand out a loose SHA. Downloading history is the way around it.

      "Not our ref" is the remote saying it does not have that object.
      Downloading history cannot make it appear — and from github.com the answer
      is final, because GitHub does serve any reachable SHA, so there is nothing
      the escalation below could find. Said plainly here instead of after four
      fetches, which on a large repository is minutes spent on a typo.

      Anything else — network, auth, a full disk — is not a protocol problem and
      is not this function's to interpret.
    */
    if (/does not allow request for unadvertised object|unadvertised object/i.test(message)) {
      refused = true;
    } else if (/not our ref|no such remote ref|couldn't find remote ref/i.test(message)) {
      if (isGitHubHost(originUrl)) throw unreachable();
      refused = true;
    } else {
      throw err;
    }
  }

  if (refused || !(await hasCommit())) {
    // English, like every other line of a build log: it sits between npm and
    // docker output. The errors thrown from here stay Italian — those surface in
    // the panel, next to the rest of its own writing.
    log(`Single-commit fetch did not deliver ${short}; deepening ${branch} history...`);

    // `.git/shallow` exists if and only if the clone is truncated. Asking git
    // (`rev-parse --is-shallow-repository`) would cost a process for the same
    // answer, and the distinction matters: `--deepen` on a complete repository
    // is pointless while `--unshallow` there is a hard error.
    const isShallow = () => fs.existsSync(path.join(repoDir, ".git", "shallow"));
    const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;

    const deepen = async (args: string[], timeout: number) => {
      try {
        await exec("git", [...authArgs(token, originUrl), "fetch", ...args, "origin", refspec], {
          cwd: repoDir,
          timeout,
          env: gitEnv,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Same mapping, and deliberately the same string, as gitPull: this is
        // the first call here that names a branch.
        if (/couldn't find remote ref|not found in upstream/i.test(message)) {
          throw new Error(`Il branch "${branch}" non esiste sul remote.`);
        }
        throw err;
      }
    };

    for (const step of [50, 200, 1000]) {
      if (!isShallow()) break;
      await deepen([`--deepen=${step}`], 180_000);
      if (await hasCommit()) break;
    }

    if (!(await hasCommit())) {
      if (isShallow()) {
        log("Fetching the branch's full history...");
        // Years of history: the ordinary fetch timeout is not enough.
        await deepen(["--unshallow"], 300_000);
      } else {
        await deepen([], 180_000);
      }
    }

    if (!(await hasCommit())) throw unreachable();
  }

  // Detached first, and it is not cosmetic: without it `reset --hard` moves the
  // local branch, and the repository ends up with a `main` label hanging off a
  // commit that is not the head of main. Swallowed on failure — the deploy works
  // identically with HEAD attached, and an old git has no bare `checkout
  // --detach`.
  try {
    await exec("git", ["checkout", "--detach"], { cwd: repoDir, timeout: 30_000 });
  } catch { /* stays attached: the reset below still does the right thing */ }

  await exec("git", ["reset", "--hard", target], { cwd: repoDir, timeout: 30_000 });

  // Same as gitPull: drop the files the previous commit tracked and this one
  // does not, keep the ignored artefacts (node_modules, .next, venv) in place.
  await exec("git", ["clean", "-fd"], { cwd: repoDir, timeout: 60_000 });

  // Read back rather than echo: the deployment row records the message on the
  // object, not a string a browser typed.
  return getLatestCommit(projectSlug);
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
