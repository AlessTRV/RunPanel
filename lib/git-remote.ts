/**
 * What a remote URL is allowed to be, and where a credential may travel.
 *
 * A sibling of `lib/git-ref.ts` rather than part of it: that file is a tight
 * argument about git's *argument parsing* — the accepted character set as the
 * whole defence against `--upload-pack=`. A remote URL asks a different
 * question. Not "can this reach the shell" but "may this reach a screen, and
 * may the token go there".
 *
 * No imports at all, for the same reason `lib/git-ref.ts` has none: the unit
 * suites load these files directly with Node's strip-only TypeScript loader,
 * which resolves neither the `@/` alias nor an extensionless relative path.
 * Keeping the rules pure is also what lets them be held against a table of real
 * URLs instead of being reasoned about.
 */

/**
 * A scp-style remote: `git@github.com:Owner/Repo.git`.
 *
 * It has no `://`, which is exactly how it is told apart from `ssh://git@…`.
 * `new URL()` throws on it, so every rule here has to check for it first rather
 * than parse and hope.
 */
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/;

function isScpLike(value: string): boolean {
  return !value.includes("://") && SCP_LIKE.test(value);
}

/**
 * A remote URL with any embedded credentials removed.
 *
 * Anchored and scheme-generic, because the version this replaces matched only
 * `https://` — so an `http://user:token@host` origin round-tripped to the
 * browser intact, and `git://` and `ssh://` were never considered at all.
 *
 * ssh and git are treated differently on purpose. On http(s) the userinfo is a
 * credential and nothing else. On ssh it is the account being logged in as:
 * `ssh://git@github.com/x` with the `git@` removed is a different and broken
 * address — and `cleanOrigin()` in `services/git-manager.ts` WRITES this value
 * back with `git remote set-url`. So the password half goes and the user half
 * stays.
 *
 * `[^/@]*` cannot cross a `/`, so `https://github.com/a@b/c` is left alone, and
 * scp-style has no `://` and never matches.
 */
export function stripRemoteCredentials(url: string): string {
  return url.replace(
    /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@]*)@/,
    (_all, scheme: string, userinfo: string) => {
      if (/^https?:\/\/$/i.test(scheme)) return scheme;
      const user = userinfo.split(":")[0];
      return user ? `${scheme}${user}@` : scheme;
    }
  );
}

/**
 * Whether this remote is one whose answers the panel may trust as GitHub's.
 *
 * Two callers, for two different reasons: the auth plan below because the token
 * may only be sent here, and `gitCheckoutCommit` because GitHub serves any
 * reachable SHA — so from here "not our ref" is a final answer rather than a
 * limitation to work around.
 *
 * The scheme check is not decoration. Without it `http://github.com/x` counted
 * as GitHub, and the panel would attach the operator's token to a request it
 * sends in clear text over the network.
 */
export function isGitHubHost(remoteUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "github.com" || host.endsWith(".github.com");
}

/**
 * Whether an update fetched from this remote could be trusted at all.
 *
 * The panel's self-update does `git reset --hard` to whatever the remote hands
 * back and then runs that tree's install scripts and build. Over `http://` or
 * `git://` anyone on the path chooses what runs; `file://` is not a fetch at
 * all. So the transport is checked before the fetch rather than after, and the
 * shape of the check follows `repoUrlSchema` in `lib/validation.ts`, which
 * already makes this argument for project repositories:
 * `z.string().url()` on its own accepts `file:///etc`, `ssh://…` and
 * `javascript:…` — it checks shape, not reachability or scheme.
 *
 * ssh counts as secure, in both spellings — it is how most people clone a
 * private repository, and it authenticates the host.
 */
export function isSecureRemote(url: string): boolean {
  const value = url.trim();
  if (!value) return false;
  if (isScpLike(value)) return true;

  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    return false;
  }
  return protocol === "https:" || protocol === "ssh:" || protocol === "git+ssh:";
}

/**
 * The furthest a credential is allowed to travel, as a git config URL.
 *
 * The origin and not the full remote URL, deliberately. Git's rule for
 * `http.<url>.*` is that a config URL with no user matches any user and a
 * config URL with no path matches any path, so the origin pins scheme, host and
 * port while still matching the URL git actually dials — which matters because
 * `parseRemoteUrl` hands back a remote with the credentials already stripped,
 * so what the panel knows and what git dials are not the same string.
 *
 * Verified against git rather than assumed: a key scoped to
 * `https://github.com` matches `https://user:token@github.com/x/y.git`, and
 * does not match another host or the same host over `http://`.
 */
export function authScope(remoteUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return url.origin;
}

/**
 * Git configuration carried in the environment instead of on the command line.
 *
 * `GIT_CONFIG_COUNT` plus the numbered key/value pairs, which git has read
 * since 2.31. The point is not convenience: `/proc/<pid>/cmdline` is
 * world-readable and `ps` shows it to every local user, while
 * `/proc/<pid>/environ` is readable only by the owner.
 */
export function gitConfigEnv(entries: Array<[string, string]>): Record<string, string> {
  if (entries.length === 0) return {};

  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

export interface GitAuthPlan {
  /**
   * Spliced in before the git subcommand. Empty unless git is too old to read
   * its configuration from the environment.
   */
  args: string[];
  /** Variables to merge into the child's environment. */
  env: Record<string, string>;
}

/**
 * How to prove to a remote that the panel is allowed in.
 *
 * Gated on the destination, and that is the whole point: an `extraheader`
 * applies to the command, not to a host. Git sends it to whatever it connects
 * to, so building this for a URL on somebody else's server posts the operator's
 * GitHub token to that server's access log.
 *
 * Two things changed here relative to the version that only returned argv:
 *
 * The header now travels in the environment, so it no longer appears in
 * `execFile`'s `Command failed: <argv>` rejection message — which is what used
 * to carry it into the deploy log and into `deployments.error_message`.
 *
 * And the config key is scoped to the remote in BOTH branches. `http.<url>.*`
 * matching has existed since git 1.8.5, so even the old-git fallback stops
 * handing the header to a redirect target. That part was a correctness bug, not
 * a visibility one.
 */
export function gitAuthPlan(
  token: string | null,
  remoteUrl: string,
  envConfigSupported: boolean
): GitAuthPlan {
  const entries = authConfigEntries(token, remoteUrl);
  if (entries.length === 0) return { args: [], env: {} };

  if (envConfigSupported) return { args: [], env: gitConfigEnv(entries) };
  return { args: configArgs(entries), env: {} };
}

/**
 * The git configuration that authenticates this remote, as key/value pairs.
 *
 * Separate from `gitAuthPlan` because signature verification needs to add its
 * own keys to the same set: `GIT_CONFIG_COUNT` numbers one flat list, so two
 * callers each building their own block would have the second silently
 * overwrite the first — and the failure mode of getting that wrong is a fetch
 * that quietly stops authenticating.
 */
export function authConfigEntries(
  token: string | null,
  remoteUrl: string
): Array<[string, string]> {
  const scope = authScope(remoteUrl);
  if (!token || !scope || !isGitHubHost(remoteUrl)) return [];

  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return [[`http.${scope}.extraheader`, `Authorization: basic ${encoded}`]];
}

/** The same configuration as `-c key=value` argv, for a git too old to read it from the environment. */
export function configArgs(entries: Array<[string, string]>): string[] {
  return entries.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}
