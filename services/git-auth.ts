import { execFile } from "child_process";
import { promisify } from "util";
import { getSetting } from "@/lib/settings";
import { decrypt } from "@/lib/crypto";
import { sanitizedProcessEnv } from "@/lib/env";
import { authConfigEntries, configArgs, gitAuthPlan, gitConfigEnv } from "@/lib/git-remote";

const exec = promisify(execFile);

/**
 * Talking to a git remote as somebody, and only to the right somebody.
 *
 * Lifted out of `services/git-manager.ts` when the panel learned to update
 * itself, because that path needs exactly the same decisions on a repository
 * that is not a project. The rules themselves now live in `lib/git-remote.ts`,
 * pure and testable; what is left here is everything that needs the database,
 * the secret, or a child process — which is why this file may use the `@/`
 * alias and that one may not.
 */

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
 *
 * Built from `sanitizedProcessEnv()` rather than `process.env`, like
 * `services/docker/cli.ts` and `services/env-utils.ts` already do. Git has no
 * use for `RUNPANEL_SECRET` — the key every credential in the store is
 * encrypted under — and a subprocess that does not receive a secret cannot
 * leak it. Nothing git does need is removed: `PRIVATE_ENV_KEYS` covers only
 * RunPanel's own configuration and the database variables, so `PATH`, `HOME`,
 * `SSH_AUTH_SOCK`, every `GIT_*` and every proxy variable survive.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return { ...sanitizedProcessEnv(), GIT_TERMINAL_PROMPT: "0" };
}

const PROBE_VALUE = "runpanel-env-config-probe";

let envConfigProbe: Promise<boolean> | null = null;

/**
 * Whether this host's git reads its configuration from the environment.
 *
 * `GIT_CONFIG_COUNT` arrived in git 2.31, in March 2021. Older git does not
 * reject it — it ignores it *silently*, which would turn an authenticated fetch
 * into an anonymous one and report the result as "Repository not found". There
 * is no `engines` field in `package.json` and no documented git floor, so this
 * is asked rather than assumed.
 *
 * Asked in the form that proves the url-matching too, not just the version:
 * `--get-urlmatch` answers the exact question the auth plan depends on. No
 * network, no repository, one process, and the answer is cached for the life of
 * the panel. It is only ever reached when there is a token *and* the remote is
 * GitHub, so an anonymous clone of a public repository pays nothing.
 */
async function supportsEnvConfig(): Promise<boolean> {
  envConfigProbe ??= (async () => {
    try {
      const { stdout } = await exec(
        "git",
        ["config", "--get-urlmatch", "http.extraheader", "https://runpanel.invalid/probe.git"],
        {
          timeout: 5_000,
          windowsHide: true,
          // `gitEnv()` and not `process.env`, for the same reason as everywhere
          // else here: there is no call for RunPanel's own secret to be in the
          // environment of a probe that only reads a config value back.
          env: {
            ...gitEnv(),
            ...gitConfigEnv([["http.https://runpanel.invalid.extraheader", PROBE_VALUE]]),
          },
        }
      );
      return stdout.toString().trim() === PROBE_VALUE;
    } catch {
      // `git config --get-urlmatch` exits 1 when nothing matched, which is also
      // what a git too old to have read the variables at all does.
      return false;
    }
  })();
  return envConfigProbe;
}

/**
 * The argv prefix and the environment a git command needs to reach this remote.
 *
 * One call per command, replacing the old `authArgs` + `gitEnv` pair. The two
 * halves have to be decided together now: whether the credential goes in the
 * environment or on the command line depends on what this host's git can read,
 * and the caller should not have to know that.
 */
export async function gitAuth(
  token: string | null,
  remoteUrl: string
): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const base = gitEnv();
  if (!token) return { args: [], env: base };

  const plan = gitAuthPlan(token, remoteUrl, await supportsEnvConfig());
  return { args: plan.args, env: { ...base, ...plan.env } };
}

/**
 * The same, plus extra git configuration the caller wants applied.
 *
 * Exists for commit signature verification, which needs `gpg.format` and
 * `gpg.ssh.allowedSignersFile` set for exactly one command. Merged into the one
 * `GIT_CONFIG_COUNT` block so the two cannot overwrite each other's numbering —
 * the failure mode of getting that wrong is a fetch that silently stops
 * authenticating.
 */
export async function gitAuthWithConfig(
  token: string | null,
  remoteUrl: string,
  extra: Array<[string, string]>
): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const base = gitEnv();
  const entries = [...authConfigEntries(token, remoteUrl), ...extra];
  if (entries.length === 0) return { args: [], env: base };

  if (await supportsEnvConfig()) {
    return { args: [], env: { ...base, ...gitConfigEnv(entries) } };
  }
  // Old git: everything goes on the command line, because this git will not
  // read an environment block at all.
  return { args: configArgs(entries), env: base };
}
