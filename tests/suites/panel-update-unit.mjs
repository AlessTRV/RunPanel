import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * The decisions that make the panel's self-update safe, checked without one.
 *
 * Everything here is a pure function of its arguments, and that is the point:
 * these are the four judgements that decide whether the panel overwrites its
 * own running build, whether it kills a process nothing will restart, and
 * whether it can read its own changelog. Getting any of them wrong costs a
 * server, so they should be verifiable on a laptop.
 *
 * Standalone, because none of the modules loaded here import the database, the
 * `@/` alias or anything else Node's strip-only TypeScript loader cannot follow.
 */
export const meta = { name: "panel-update-unit", needsDocker: false, drivers: [], standalone: true };

const SYSTEMD = {
  environment: { containerised: false, containerRuntime: null },
  systemd: { active: true, installed: true, enabled: true },
  cron: { installed: false },
  selfContainer: { id: null, restartPolicy: null },
};

const CRON = {
  environment: { containerised: false, containerRuntime: null },
  systemd: { active: false, installed: false, enabled: false },
  cron: { installed: true },
  selfContainer: { id: null, restartPolicy: null },
};

const BARE = {
  environment: { containerised: false, containerRuntime: null },
  systemd: { active: false, installed: false, enabled: false },
  cron: { installed: false },
  selfContainer: { id: null, restartPolicy: null },
};

const CONTAINER = {
  environment: { containerised: true, containerRuntime: "docker" },
  systemd: { active: false, installed: false, enabled: false },
  cron: { installed: false },
  selfContainer: { id: "abc123", restartPolicy: "unless-stopped" },
};

export async function run({ repoRoot }) {
  const r = createReporter("panel-update-unit");

  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

  const { parseCommitLog, parseBranch, parseRemoteUrl, COMMIT_FORMAT } = await load(
    "services", "panel-update", "git.ts"
  );
  const { canSelfUpdate, configSupportsStagedBuild, explainGitError } = await load(
    "services", "panel-update", "policy.ts"
  );
  const { settleOnBoot, isTerminal } = await load("services", "panel-update", "state.ts");
  const { detectPackageManager, resolvePackageManager } = await load("services", "package-manager.ts");
  const { isPanelUpdateInterval, DEFAULT_PANEL_UPDATE_INTERVAL, PANEL_UPDATE_INTERVALS } =
    await load("lib", "polling.ts");
  const { hasUpdate, isUpdateActive } = await load("lib", "panel-update.ts");

  // --- The commit log -------------------------------------------------------
  //
  // Real subjects from this repository, because the whole reason the format
  // uses unit separators is that these contain colons, apostrophes and emoji.
  const record = (sha, author, date, subject) =>
    `${sha}\x1f${author}\x1f${date}\x1f${subject}\x1e`;

  const log = [
    record(
      "4d480c77bd43af994d435e8437f9b4870a276172",
      "AlessTRV",
      "2026-08-17T22:33:34+02:00",
      "projects: 🚚 Added moving a native project's checkout to another disk"
    ),
    record(
      "dd500d8da530d0390c7d01a1e7d05dfbe58b7630",
      "AlessTRV",
      "2026-08-17T19:35:12+02:00",
      "projects: 📁 Added the same bind list to Docker projects"
    ),
  ].join("\n");

  const commits = parseCommitLog(log);
  r.check("it reads every record", commits.length === 2, `got ${commits.length}`);
  r.check("it keeps the full sha", commits[0].sha.length === 40);
  r.check("it derives the short sha", commits[0].short === "4d480c7", commits[0].short);
  r.check(
    "a subject with a colon and an emoji survives intact",
    commits[0].subject === "projects: 🚚 Added moving a native project's checkout to another disk",
    commits[0].subject
  );
  r.check("it keeps the author date as given", commits[1].date === "2026-08-17T19:35:12+02:00");

  r.check("empty output is no commits, not a crash", parseCommitLog("").length === 0);
  r.check("whitespace only is no commits", parseCommitLog("\n\n").length === 0);

  // A pipe or a tab as delimiter would split this one in the wrong place; the
  // separators the format actually uses cannot appear in a git subject.
  const tricky = parseCommitLog(
    record("a".repeat(40), "Someone", "2026-01-01T00:00:00Z", "fix: a | b\tc — d")
  );
  r.check("a subject containing a pipe and a tab stays one field",
    tricky.length === 1 && tricky[0].subject === "fix: a | b\tc — d", tricky[0]?.subject);

  r.check("the format string asks for the separators the parser expects",
    COMMIT_FORMAT.includes("%x1f") && COMMIT_FORMAT.includes("%x1e"), COMMIT_FORMAT);

  // --- Branch and remote ----------------------------------------------------
  r.check("a named branch is not detached", parseBranch("main\n").branch === "main");
  r.check("HEAD means detached", parseBranch("HEAD\n").detached === true);
  r.check("detached has no branch", parseBranch("HEAD\n").branch === null);
  r.check("no output means detached", parseBranch("").detached === true);

  r.check(
    "a remote url loses its embedded credentials",
    parseRemoteUrl("https://user:ghp_secret@github.com/AlessTRV/RunPanel.git\n") ===
      "https://github.com/AlessTRV/RunPanel.git",
    parseRemoteUrl("https://user:ghp_secret@github.com/AlessTRV/RunPanel.git\n")
  );
  r.check("an ssh remote is left alone",
    parseRemoteUrl("git@github.com:AlessTRV/RunPanel.git\n") === "git@github.com:AlessTRV/RunPanel.git");
  r.check("no remote is null", parseRemoteUrl("") === null);

  // --- Who may kill the panel ----------------------------------------------
  //
  // The matrix that decides whether the process exits. Every `ok: true` here is
  // a promise that something will start it again.
  const prod = (probe) => canSelfUpdate(probe, "linux", "production");

  r.check("systemd can be updated in place", prod(SYSTEMD).ok === true);
  r.check("systemd is the restart method", prod(SYSTEMD).restart === "systemd");
  r.check("a cron-supervised host can too", prod(CRON).ok === true && prod(CRON).restart === "cron");

  // Not a refusal: the work is worth doing, it just stops before the swap.
  r.check("a host with no supervisor still runs, but manually",
    prod(BARE).ok === true && prod(BARE).restart === "manual");
  r.check("and it says why", typeof prod(BARE).reason === "string" && prod(BARE).reason.length > 0);

  r.check("a containerised panel is refused", prod(CONTAINER).ok === false);
  r.check("the refusal explains the writable layer",
    /immagine|container/i.test(prod(CONTAINER).reason ?? ""), prod(CONTAINER).reason);

  // Windows cannot rename a directory that has open handles, and `.next/trace`
  // is held open by the running server.
  r.check("Windows is refused", canSelfUpdate(SYSTEMD, "win32", "production").ok === false);

  // In development Next puts its build in `<distDir>/dev`, so a swap would take
  // the development cache with it.
  r.check("development is refused", canSelfUpdate(SYSTEMD, "linux", "development").ok === false);
  r.check("an unset NODE_ENV is refused", canSelfUpdate(SYSTEMD, "linux", undefined).ok === false);

  // --- The config tripwire --------------------------------------------------
  //
  // The most important assertion in this file. `next.config.ts` arrives on a
  // machine INSIDE the update, so a future commit that tidies the distDir line
  // away would make the next update build straight over the live `.next`. The
  // updater refuses to build when it cannot find the variable; this checks the
  // refusal works, and the two below check the repository still deserves to
  // pass it.
  const realConfig = readFileSync(join(repoRoot, "next.config.ts"), "utf8");
  r.check("the repo's own next.config passes the check", configSupportsStagedBuild(realConfig));
  r.check("a config without the variable is rejected",
    configSupportsStagedBuild("export default { distDir: '.next' }") === false);

  r.check(
    "next.config.ts still routes the build through RUNPANEL_DIST_DIR",
    realConfig.includes("RUNPANEL_DIST_DIR"),
    "removing it would make the next self-update overwrite the running build"
  );

  const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  r.check(
    ".gitignore still hides the staging directory",
    gitignore.includes("/.next-update/"),
    "otherwise `git clean -fd` during an update deletes the build in progress"
  );
  r.check(
    ".gitignore still hides the rollback directory",
    gitignore.includes("/.next-old/"),
    "otherwise the next update's `git clean -fd` deletes the only way back"
  );

  // --- What git said, and what it means -------------------------------------
  //
  // The wording that sends people looking in the wrong place: GitHub answers a
  // repository it will not serve with "not found", never "forbidden", so the
  // message reads as if the remote URL were wrong when it is fine.
  const refused = explainGitError(
    "Command failed: git fetch origin" + String.fromCharCode(10) +
      "remote: Repository not found." + String.fromCharCode(10) +
      "fatal: repository 'https://github.com/AlessTRV/RunPanel.git/' not found"
  );
  r.check("a refused remote says so plainly", /rifiutato/i.test(refused), refused);
  r.check("the command line is stripped", !refused.includes("Command failed"), refused);

  for (const raw of [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "fatal: Authentication failed for 'https://github.com/AlessTRV/RunPanel.git/'",
    "remote: Invalid username or password.",
  ]) {
    r.check(`"${raw.slice(0, 34)}…" reads as a refusal`, /rifiutato/i.test(explainGitError(raw)));
  }

  const offline = explainGitError(
    "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com"
  );
  r.check(
    "an unreachable remote is a network problem, not a permission one",
    /raggiungibile/i.test(offline) && !/rifiutato/i.test(offline),
    offline
  );

  r.check("anything else is passed through", explainGitError("fatal: bad object") === "fatal: bad object");
  r.check("an empty message still says something", explainGitError("") === "errore sconosciuto");

  // --- Boot transitions -----------------------------------------------------
  const base = {
    runId: "r1",
    phase: "awaiting-restart",
    step: "Riavvio",
    branch: "main",
    fromSha: "a".repeat(40),
    toSha: "b".repeat(40),
    packageManager: "npm",
    startedAt: "2026-08-18T10:00:00.000Z",
    finishedAt: null,
    bootedAt: null,
    error: null,
    storeBackup: null,
    distBackup: null,
    manualCommands: [],
  };
  const NOW = "2026-08-18T10:05:00.000Z";

  // Arriving here at all is the proof the update worked: the only way this code
  // runs is a process that loaded the build the update swapped in.
  const restarted = settleOnBoot(base, NOW);
  r.check("a restart that came back is done", restarted.phase === "done");
  r.check("and records when it came back", restarted.bootedAt === NOW);

  const interrupted = settleOnBoot({ ...base, phase: "running" }, NOW);
  r.check("a run interrupted by a restart is failed", interrupted.phase === "failed");
  r.check("and says the running version is the old one",
    /versione in esecuzione/i.test(interrupted.error ?? ""), interrupted.error);

  const manual = settleOnBoot({ ...base, phase: "awaiting-manual" }, NOW);
  r.check("a run waiting on a human is left alone", manual.phase === "awaiting-manual");
  r.check("settling is idempotent",
    settleOnBoot(restarted, "2026-08-18T11:00:00.000Z").phase === "done");

  r.check("done is terminal", isTerminal("done") === true);
  r.check("failed is terminal", isTerminal("failed") === true);
  r.check("running is not", isTerminal("running") === false);
  r.check("awaiting-restart is not", isTerminal("awaiting-restart") === false);

  // --- Package manager ------------------------------------------------------
  const dir = mkdtempSync(join(tmpdir(), "rp-pm-"));
  try {
    const lock = (name) => writeFileSync(join(dir, name), "");
    const clear = () => {
      for (const name of ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"]) {
        rmSync(join(dir, name), { force: true });
      }
    };

    r.check("no lockfile means npm", detectPackageManager(dir).cmd === "npm");

    clear(); lock("package-lock.json");
    r.check("package-lock means npm", detectPackageManager(dir).cmd === "npm");

    clear(); lock("yarn.lock");
    r.check("yarn.lock means yarn", detectPackageManager(dir).cmd === "yarn");

    clear(); lock("bun.lockb");
    r.check("bun.lockb means bun", detectPackageManager(dir).cmd === "bun");

    clear(); lock("pnpm-lock.yaml"); lock("yarn.lock"); lock("bun.lock");
    r.check("pnpm wins over the rest", detectPackageManager(dir).cmd === "pnpm");

    // RunPanel's own repository, which carries both. Detection says bun, which
    // is wrong on a server that only ever ran npm install — hence the fallback.
    clear(); lock("bun.lock"); lock("package-lock.json");
    r.check("both bun and npm lockfiles resolve to bun", detectPackageManager(dir).cmd === "bun");

    const withBun = resolvePackageManager(dir, () => "/home/op/.bun/bin/bun");
    r.check("bun is used when it is installed",
      withBun.manager.cmd === "bun" && withBun.fellBack === false);

    const withoutBun = resolvePackageManager(dir, () => null);
    r.check("and npm is used when it is not", withoutBun.manager.cmd === "npm");
    r.check("the fallback is reported so the log can say so", withoutBun.fellBack === true);
    r.check("the fallback remembers what it wanted", withoutBun.detected === "bun");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // --- What the banner decides ---------------------------------------------
  const status = (over = {}) => ({
    checkout: { isRepo: true, branch: "main", detached: false, head: "b".repeat(40), short: "bbbbbbb", remote: "https://github.com/AlessTRV/RunPanel.git" },
    check: { checkedAt: "2026-08-18T10:00:00.000Z", branch: "main", remote: null, localSha: "b".repeat(40), remoteSha: "c".repeat(40), behind: 4, commits: [], error: null },
    run: null,
    busy: null,
    ...over,
  });

  r.check("four commits behind is an update", hasUpdate(status()) === true);
  r.check("nothing behind is not", hasUpdate(status({ check: { ...status().check, behind: 0 } })) === false);
  r.check("a failed check is not", hasUpdate(status({ check: { ...status().check, error: "boom" } })) === false);
  r.check("no check at all is not", hasUpdate(status({ check: null })) === false);
  r.check("no status at all is not", hasUpdate(null) === false);

  // Somebody updated over SSH since the last check: the stored count is about a
  // commit that is no longer installed, so offering it would be a lie.
  r.check(
    "a check taken against a different HEAD is ignored",
    hasUpdate(status({ checkout: { ...status().checkout, head: "f".repeat(40) } })) === false
  );

  r.check("a live run is active", isUpdateActive(status({ busy: "run1" })) === true);
  r.check("so is one awaiting the restart",
    isUpdateActive(status({ run: { phase: "awaiting-restart" } })) === true);
  r.check("a finished one is not", isUpdateActive(status({ run: { phase: "done" } })) === false);
  r.check("nor is one waiting on a human",
    isUpdateActive(status({ run: { phase: "awaiting-manual" } })) === false);

  // --- The interval offered to the operator ---------------------------------
  r.check("the default is one of the options",
    PANEL_UPDATE_INTERVALS.includes(DEFAULT_PANEL_UPDATE_INTERVAL),
    "a value off the list renders a picker with nothing selected");
  r.check("a listed value is accepted", isPanelUpdateInterval("21600") === true);
  r.check("an unlisted value is not", isPanelUpdateInterval("300") === false);
  r.check("a number is not a valid stored value", isPanelUpdateInterval(21600) === false);

  return r.result();
}
