import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * The rules that decide what untrusted input is allowed to reach.
 *
 * Every check here failed before the hardening pass, and each one corresponds
 * to a way in that was real rather than theoretical.
 */
export const meta = { name: "security-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("security-unit");
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

  // --- the repository may not grant itself the host ------------------------
  const { stripPanelOnlyFields, resolveContract } = await load("lib", "deploy-contract.ts");

  const hostile = {
    commands: { install: "npm ci" },
    docker: { image: "node:20", mounts: ["/:/host"], capAdd: ["SYS_ADMIN"], network: "host" },
    envFile: { enabled: true, path: "../elsewhere/.env" },
  };

  const stripped = stripPanelOnlyFields(hostile);
  r.check(
    "a repo contract cannot set docker.mounts",
    stripped.contract.docker.mounts === undefined,
    JSON.stringify(stripped.contract.docker)
  );
  r.check("a repo contract cannot set docker.capAdd", stripped.contract.docker.capAdd === undefined);
  r.check("a repo contract cannot set docker.network", stripped.contract.docker.network === undefined);
  r.check("a repo contract cannot set envFile.path", stripped.contract.envFile.path === undefined);
  r.check(
    "what it may set survives",
    stripped.contract.commands.install === "npm ci" && stripped.contract.docker.image === "node:20"
  );
  r.check(
    "the rejected fields are named, so the deploy log can say so",
    stripped.rejected.includes("docker.mounts") && stripped.rejected.includes("envFile.path"),
    stripped.rejected.join(",")
  );

  // A project starts life with `builder_config: "{}"`, which is what made this
  // reachable by default rather than only on a misconfigured project.
  const resolved = resolveContract({}, stripped.contract);
  r.check("resolving an empty panel config yields no mounts", resolved.docker.mounts.length === 0);
  r.check("resolving an empty panel config yields no capabilities", resolved.docker.capAdd.length === 0);
  r.check("resolving an empty panel config keeps the project network", resolved.docker.network === "project");

  // --- path containment ----------------------------------------------------
  const { resolveInside, isPathShapeSafe } = await load("lib", "fs-safe.ts");

  const root = mkdtempSync(join(tmpdir(), "runpanel-fs-"));
  try {
    mkdirSync(join(root, "repo", "src"), { recursive: true });
    writeFileSync(join(root, "repo", "src", "index.js"), "ok");
    writeFileSync(join(root, "secret.txt"), "not yours");
    const repo = join(root, "repo");

    r.check("a normal path resolves", resolveInside(repo, "src/index.js") !== null);
    r.check("a path that does not exist yet still resolves", resolveInside(repo, "src/new.js") !== null);
    r.check("dot-dot is refused", resolveInside(repo, "../secret.txt") === null);
    // A leading slash means "root of the project" — the file manager sends
    // paths that way — so this must resolve INSIDE the repo, not to the
    // filesystem root.
    r.check(
      "a leading slash is anchored to the project, not the filesystem",
      resolveInside(repo, "/secret.txt") === join(repo, "secret.txt"),
      String(resolveInside(repo, "/secret.txt"))
    );
    r.check("a NUL byte is refused", resolveInside(repo, "src/\0.js") === null);

    // The sibling-prefix bug: `startsWith(base)` alone accepts this.
    mkdirSync(join(root, "repo-evil"), { recursive: true });
    writeFileSync(join(root, "repo-evil", "x.js"), "nope");
    r.check(
      "a sibling directory sharing the name prefix is refused",
      resolveInside(repo, "../repo-evil/x.js") === null
    );

    let symlinksAvailable = true;
    try {
      symlinkSync(join(root, "secret.txt"), join(repo, "link.txt"));
    } catch {
      // Windows needs Developer Mode or elevation to create one.
      symlinksAvailable = false;
    }

    if (symlinksAvailable) {
      r.check(
        "a symlink pointing outside the repo is refused",
        resolveInside(repo, "link.txt") === null
      );
    } else {
      console.log("    skip symlink containment (no permission to create symlinks here)");
    }

    r.check("shape check refuses dot-dot", !isPathShapeSafe("../x"));
    r.check("shape check refuses a drive letter", !isPathShapeSafe("C:/x"));
    r.check("shape check allows an ordinary path", isPathShapeSafe("/src/index.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // --- what may reach `git` as an argument ---------------------------------
  //
  // `execFile` spawns git directly, so there is no shell to escape into — but
  // git itself reads a leading `-` as an option, and `--upload-pack=<cmd>` is
  // command execution on this machine. The character set is the whole defence,
  // so it is the thing under test.
  const { isCommitSha, isBranchName } = await load("lib", "git-ref.ts");

  r.check("a commit that starts with a hyphen is refused", !isCommitSha("-upload-pack=touch"));
  r.check("an abbreviated sha is refused", !isCommitSha("3f9a2b1"));
  r.check("a ref name does not pass for a sha", !isCommitSha("refs/heads/main"));
  r.check("a traversal does not pass for a sha", !isCommitSha("../../etc/passwd"));
  r.check("uppercase is not a second spelling", !isCommitSha("A".repeat(40)));
  r.check("a trailing argument is refused", !isCommitSha(`${"a".repeat(40)} --upload-pack=x`));
  r.check("a real sha passes", isCommitSha("a".repeat(40)));
  r.check("a sha-256 object id passes", isCommitSha("b".repeat(64)));

  r.check("a branch containing .. is refused", !isBranchName("a/../b"));
  r.check("a branch starting with a hyphen is refused", !isBranchName("-x"));
  r.check("a branch with a space is refused", !isBranchName("my branch"));
  r.check("a branch ending in .lock is refused", !isBranchName("main.lock"));
  r.check("an empty branch is refused", !isBranchName(""));
  r.check("an ordinary branch passes", isBranchName("feature/login"));

  // --- what a `-v` mapping means -------------------------------------------
  //
  // This one decides whether the panel *creates* a source and whether it may
  // *delete* it. Two call sites used to answer it with `split(":")[0]`, which
  // on Windows takes the drive letter for a volume name: `C:\dati:/var/lib/…`
  // came back as `"C"`, so RunPanel created a labelled volume called `C` and
  // would have offered it for deletion with the service.
  const { mountSource, isHostPath } = await load("lib", "mount.ts");

  r.check("a named volume splits at the first colon", mountSource("runpanel-pg-db:/var/lib/postgresql") === "runpanel-pg-db");
  r.check("a posix source keeps its whole path", mountSource("/srv/dati:/var/lib/postgresql") === "/srv/dati");
  r.check(
    "a windows source keeps its drive letter",
    mountSource("C:\\dati:/var/lib/postgresql") === "C:\\dati",
    mountSource("C:\\dati:/var/lib/postgresql")
  );
  r.check(
    "a windows source with forward slashes too",
    mountSource("C:/dati:/var/lib/postgresql") === "C:/dati",
    mountSource("C:/dati:/var/lib/postgresql")
  );
  r.check("a read-only suffix does not confuse it", mountSource("/srv/dati:/data:ro") === "/srv/dati");
  r.check("a mapping with no colon is all source", mountSource("solonome") === "solonome");

  r.check("a volume name is not a host path", !isHostPath("runpanel-pg-db"));
  r.check("a posix path is", isHostPath("/srv/dati"));
  r.check("a windows path is", isHostPath("C:\\dati"));
  r.check("and so is a UNC-style one", isHostPath("\\\\server\\share"));
  // The whole point: the old code reduced this mapping to "C", and "C" is not
  // a host path — which is how a drive letter became a volume.
  r.check("the drive letter alone would not have been", !isHostPath("C"));

  // --- archive entries -----------------------------------------------------
  const { isSafeEntryPath } = await load("services", "backup", "archive-read.ts");
  r.check("zip-slip entry refused", !isSafeEntryPath("../../etc/cron.d/x"));
  r.check("absolute zip entry refused", !isSafeEntryPath("/etc/passwd"));
  r.check("windows drive zip entry refused", !isSafeEntryPath("C:\\windows\\x"));
  r.check("ordinary zip entry accepted", isSafeEntryPath("src/index.js"));

  // --- what a remote URL is allowed to be ----------------------------------
  //
  // Two copies of the credential strip exist on purpose: `lib/git-remote.ts` is
  // the canonical one, and `services/panel-update/git.ts` carries a mirror
  // because the unit suite loads that file with Node's strip-only loader, which
  // resolves neither the `@/` alias nor an extensionless relative path. One
  // table, both functions — which is what stops the two drifting apart in
  // silence, the way the previous pair did until only one of them was fixed.
  const { stripRemoteCredentials, isGitHubHost, isSecureRemote, authScope, gitAuthPlan } =
    await load("lib", "git-remote.ts");
  const { parseRemoteUrl } = await load("services", "panel-update", "git.ts");

  const REMOTES = [
    ["https://user:ghp_secret@github.com/A/R.git", "https://github.com/A/R.git"],
    ["http://user:tok@github.com/A/R.git", "http://github.com/A/R.git"],
    ["HTTPS://user:tok@github.com/A/R.git", "HTTPS://github.com/A/R.git"],
    ["https://ghp_tokenonly@github.com/A/R.git", "https://github.com/A/R.git"],
    // ssh keeps its user: it is the account, not the credential, and
    // `cleanOrigin()` writes this value back with `git remote set-url`.
    ["ssh://git:pw@github.com/A/R.git", "ssh://git@github.com/A/R.git"],
    ["ssh://git@github.com/A/R.git", "ssh://git@github.com/A/R.git"],
    ["git@github.com:AlessTRV/RunPanel.git", "git@github.com:AlessTRV/RunPanel.git"],
    ["git://github.com/A/R.git", "git://github.com/A/R.git"],
    ["https://github.com/A/R.git", "https://github.com/A/R.git"],
    // The `@` is in the path, not the userinfo.
    ["https://github.com/a@b/c.git", "https://github.com/a@b/c.git"],
  ];

  for (const [input, expected] of REMOTES) {
    r.check(`strip: ${input}`, stripRemoteCredentials(input) === expected, stripRemoteCredentials(input));
    r.check(
      `mirror agrees: ${input}`,
      parseRemoteUrl(`${input}\n`) === expected,
      parseRemoteUrl(`${input}\n`)
    );
  }

  for (const [input] of REMOTES) {
    const out = `${stripRemoteCredentials(input)} ${parseRemoteUrl(`${input}\n`)}`;
    r.check(
      `no credential survives: ${input}`,
      !out.includes("ghp_secret") && !out.includes("ghp_tokenonly") && !/:pw@|:tok@/.test(out),
      out
    );
  }

  // --- where the token is allowed to travel --------------------------------
  //
  // `http.extraheader` applies to the command, not to a host: git sends it to
  // whatever it connects to. So the gate is the whole control, and the scheme is
  // part of the gate — without it `http://github.com` counted as GitHub and the
  // panel would have posted the operator's token in clear text.
  r.check("github over https is github", isGitHubHost("https://github.com/x/y.git"));
  r.check("a subdomain is too", isGitHubHost("https://gist.github.com/x"));
  r.check("github over http is not", !isGitHubHost("http://github.com/x/y.git"));
  r.check("a lookalike host is not", !isGitHubHost("https://api.github.com.evil.com/x"));
  r.check("credentials in the url do not change the host", isGitHubHost("https://u:p@github.com/x"));
  r.check("an ssh remote is not (nothing to attach a header to)", !isGitHubHost("git@github.com:x/y.git"));
  r.check("garbage is not", !isGitHubHost("not a url"));

  const TOKEN = "ghp_" + "a".repeat(36);
  const carries = (plan) => JSON.stringify(plan.args) + JSON.stringify(plan.env);

  r.check("no token, no plan", carries(gitAuthPlan(null, "https://github.com/x/y.git", true)) === "[]{}");
  r.check(
    "the token never leaves github",
    carries(gitAuthPlan(TOKEN, "https://gitlab.com/x/y.git", true)) === "[]{}",
    carries(gitAuthPlan(TOKEN, "https://gitlab.com/x/y.git", true))
  );
  r.check(
    "and never over http",
    carries(gitAuthPlan(TOKEN, "http://github.com/x/y.git", true)) === "[]{}",
    carries(gitAuthPlan(TOKEN, "http://github.com/x/y.git", true))
  );

  const modern = gitAuthPlan(TOKEN, "https://github.com/x/y.git", true);
  const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

  // The point of the whole change: nothing on the command line, where
  // /proc/<pid>/cmdline is world-readable and every execFile rejection message
  // pastes the argv into the deploy log.
  r.check("nothing lands in argv", modern.args.length === 0, JSON.stringify(modern.args));
  r.check("the header is in the environment", modern.env.GIT_CONFIG_COUNT === "1", JSON.stringify(modern.env));
  r.check(
    "scoped to the remote, so a redirect cannot carry it",
    modern.env.GIT_CONFIG_KEY_0 === "http.https://github.com.extraheader",
    modern.env.GIT_CONFIG_KEY_0
  );
  r.check("and it is the token", modern.env.GIT_CONFIG_VALUE_0 === `Authorization: basic ${encoded}`);
  r.check(
    "the token is nowhere in argv",
    !JSON.stringify(modern.args).includes(TOKEN) && !JSON.stringify(modern.args).includes(encoded),
    JSON.stringify(modern.args)
  );

  // Git older than 2.31 ignores the environment block silently, so the fallback
  // has to stay — but it is url-scoped now too, which the version it replaces
  // was not.
  const legacy = gitAuthPlan(TOKEN, "https://github.com/x/y.git", false);
  r.check("old git still authenticates", legacy.args[0] === "-c", JSON.stringify(legacy.args));
  r.check(
    "and its fallback is scoped too",
    legacy.args[1].startsWith("http.https://github.com.extraheader="),
    legacy.args[1]
  );

  r.check("a scope keeps a non-default port", authScope("https://github.com:8443/x") === "https://github.com:8443");
  r.check("an ssh remote has no scope", authScope("git@github.com:A/R.git") === null);
  r.check("nor does an http one", authScope("http://github.com/x") === null);

  // --- which transports an update may come from ----------------------------
  //
  // The self-update resets the tree to whatever the remote hands back and then
  // runs that tree's install scripts. Over http:// or git:// whoever is on the
  // network path chooses what runs.
  r.check("https is a fetch that can be trusted", isSecureRemote("https://github.com/A/R.git"));
  r.check("so is ssh", isSecureRemote("ssh://git@github.com/A/R.git"));
  r.check("and scp-style ssh", isSecureRemote("git@github.com:A/R.git"));
  r.check("http is not", !isSecureRemote("http://github.com/A/R.git"));
  r.check("the git protocol is not", !isSecureRemote("git://github.com/A/R.git"));
  r.check("a file url is not a fetch at all", !isSecureRemote("file:///srv/repo.git"));
  r.check("nor is a bare path", !isSecureRemote("/srv/repo.git"));
  r.check("nor is nothing", !isSecureRemote(""));

  // --- nothing that looks like a credential gets written down --------------
  //
  // The header travels in the environment now, so it is no longer in the argv
  // that execFile pastes into its rejection message. This is the belt to that
  // pair of braces — and it also covers a remote URL somebody typed with the
  // credentials still in it.
  const { redactGitSecrets } = await load("lib", "redact.ts");

  const failure =
    `Command failed: git -c http.https://github.com.extraheader=Authorization: basic ${encoded} fetch origin\n` +
    "fatal: repository not found";
  const cleaned = redactGitSecrets(failure);
  r.check("an extraheader is redacted", !cleaned.includes(encoded), cleaned);
  r.check("and what git said survives", cleaned.includes("repository not found"), cleaned);

  r.check(
    "a credential in a url is redacted",
    !redactGitSecrets("https://user:ghp_x@github.com/A/R.git").includes("ghp_x"),
    redactGitSecrets("https://user:ghp_x@github.com/A/R.git")
  );
  r.check(
    "but the host is kept",
    redactGitSecrets("https://user:ghp_x@github.com/A/R.git").includes("github.com"),
    "an error that no longer says where it was going is a worse error"
  );
  r.check("a bare token is redacted", !redactGitSecrets(`token ${TOKEN}`).includes(TOKEN));
  r.check(
    "a fine-grained pat is redacted",
    !redactGitSecrets("github_pat_" + "b".repeat(40)).includes("b".repeat(40))
  );

  const ordinary = "error: pathspec 'main' did not match any file(s) known to git";
  r.check(
    "ordinary git output passes through untouched",
    redactGitSecrets(ordinary) === ordinary,
    "a deploy log full of <redatto> is a log nobody trusts"
  );

  return r.result();
}
