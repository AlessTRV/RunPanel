import fs from "fs";
import os from "os";
import path from "path";
import { sql } from "kysely";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { generateId } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { AppendLogFile, logPathFor, pruneLogDir } from "../log-file";
import { HOST_CHANNEL, opsEvents } from "../events";
import { runCommand } from "../builders/run-command";
import { resolvePackageManager } from "../package-manager";
import { whichSync } from "../env-utils";
import { isSecureRemote } from "@/lib/git-remote";
import { redactGitSecrets } from "@/lib/redact";
import { getGitHubToken, gitAuth, gitAuthWithConfig } from "../git-auth";
import { probeAutostart } from "../autostart/probe";
import { activeBackupRunId } from "../backup/runner";
import { verifySqlite } from "../backup/panel-store";
import {
  cleanUntracked,
  commitsBehind,
  fetchRemote,
  panelRoot,
  readCheckout,
  remoteHead,
  resetHard,
  verifyCommit,
  wouldClean,
  type PanelCheckout,
} from "./git";
import {
  canSelfUpdate,
  configSupportsStagedBuild,
  explainGitError,
  explainVerifyFailure,
  insecureRemoteReason,
  signatureAccepted,
  type RestartMethod,
} from "./policy";
import { signatureRequired, signingConfig } from "./signing";
import {
  clearState,
  isTerminal,
  readState,
  writeState,
  type PanelUpdateState,
} from "./state";

/**
 * Updating the program that is running this function.
 *
 * Two things make this different from deploying a project, and both are
 * consequences of the same fact — the process doing the work is the process
 * being replaced.
 *
 * **The build cannot go where the running server reads from.** `next build`
 * empties its output directory and rewrites it, and `next start` reads chunks
 * out of that directory on every request. Building over `.next` would break the
 * very page showing the progress, and a build that failed halfway would leave
 * the panel unable to start at all. So the build goes to `.next-update` and is
 * swapped in with two renames, only once it has been checked.
 *
 * **The restart is an exit.** systemd has `Restart=always`, the cron script has
 * a supervision loop, a container has a restart policy: each of them brings the
 * panel back on its own. `systemctl restart` would be worse than unnecessary —
 * systemd would stop the unit, killing the `systemctl` child that is waiting on
 * it. Exiting needs no privileges and works everywhere.
 */

/** `EX_TEMPFAIL`. See `restart()` for why the code is not zero. */
const RESTART_EXIT_CODE = 75;

/** Long enough for the last SSE frame to leave the socket. */
const RESTART_DELAY_MS = 1_500;

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;

/** Two gigabytes: a build of this project plus the copy of the previous one. */
const REQUIRED_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/** Pre-update copies of the store to keep. Three updates back is generous. */
const KEEP_STORE_DUMPS = 3;

/**
 * The heap ceiling for the panel's own build, written down instead of inherited.
 *
 * Node picks a limit from the machine's RAM when nothing says otherwise —
 * roughly 2 GB on a 4 GB server. That number is wrong twice over. V8 lets the
 * heap grow towards whatever ceiling it is given, so a high one simply means
 * more garbage kept around; and this build runs on the box the panel serves
 * from, next to the projects it hosts, where that memory is not free. The build
 * then spends its time in garbage collection and dies at the ceiling with
 * `Ineffective mark-compacts near heap limit` — a failed update, on a build
 * that needs about 600 MB when measured on its own.
 *
 * A lower ceiling makes V8 collect earlier, and the floor here is well clear of
 * what the build actually needs. An operator who has already set
 * `--max-old-space-size` had a reason: theirs wins, untouched.
 */
function buildHeapEnv(): Record<string, string> {
  const inherited = process.env.NODE_OPTIONS ?? "";
  if (inherited.includes("--max-old-space-size")) return {};

  const share = Math.floor((os.totalmem() * 0.4) / (1024 * 1024));
  const megabytes = Math.min(4096, Math.max(1024, share));
  return { NODE_OPTIONS: `${inherited} --max-old-space-size=${megabytes}`.trim() };
}

const STAGING_DIR = ".next-update";
const PREVIOUS_DIR = ".next-old";
const LIVE_DIR = ".next";

export { canSelfUpdate, configSupportsStagedBuild } from "./policy";
export type { CanUpdate, RestartMethod } from "./policy";

export class PanelUpdateBusyError extends Error {
  constructor(message = "Un aggiornamento è già in corso") {
    super(message);
    this.name = "PanelUpdateBusyError";
  }
}

/**
 * The lock, on `globalThis` for the reason every other timer here is: a
 * dev-mode module reload must not hand out a second one. Same shape as
 * `__runpanelBackupActive`.
 */
const globalRef = globalThis as typeof globalThis & { __runpanelUpdateActive?: string | null };

export function activePanelUpdate(): string | null {
  return globalRef.__runpanelUpdateActive ?? null;
}

export function updateLogDir(): string {
  return path.join(config.logsDir, "panel-updates");
}

// --- Running -----------------------------------------------------------------

interface Runner {
  state: PanelUpdateState;
  log: AppendLogFile;
  checkout: PanelCheckout;
  say: (line: string) => void;
  step: (name: string) => void;
}

function emitStatus(state: PanelUpdateState): void {
  opsEvents.emit(HOST_CHANNEL, {
    type: "panel-update:status",
    phase: state.phase,
    step: state.step ?? undefined,
    error: state.error ?? undefined,
  });
}

export interface StartResult {
  runId: string;
  /** Resolves when the run is over — or never, when the run ends by exiting. */
  done: Promise<void>;
}

export interface StartOptions {
  /** The SHA the operator was looking at when they pressed the button. */
  expectedSha?: string | null;
}

/**
 * Begin an update and return as soon as its state file exists, with the work
 * still going — the shape `startBackup()` already uses, and necessary here for
 * a different reason: the response has to be on the wire long before the
 * process that would have sent it goes away.
 */
export async function startPanelUpdate(opts: StartOptions = {}): Promise<StartResult> {
  if (globalRef.__runpanelUpdateActive) throw new PanelUpdateBusyError();

  const runId = generateId();
  globalRef.__runpanelUpdateActive = runId;

  const checkout = await readCheckout(panelRoot());
  const now = new Date().toISOString();

  const state: PanelUpdateState = {
    runId,
    phase: "running",
    step: "Preparazione",
    branch: checkout.branch,
    fromSha: checkout.head,
    toSha: null,
    packageManager: null,
    startedAt: now,
    finishedAt: null,
    bootedAt: null,
    error: null,
    storeBackup: null,
    distBackup: null,
    manualCommands: [],
  };

  writeState(config.dataDir, state);
  emitStatus(state);

  const log = new AppendLogFile(logPathFor(updateLogDir(), runId));
  // One log per run, and only the last handful kept: these are minutes of build
  // output each, and nobody reads the fourth-most-recent one.
  pruneLogDir(updateLogDir(), new Set([runId]));

  const done = execute({ state, log, checkout, say: () => {}, step: () => {} }, opts)
    .catch((err) => {
      console.error("[panel-update] Aggiornamento non riuscito:", err);
    })
    .finally(() => {
      globalRef.__runpanelUpdateActive = null;
    });

  return { runId, done };
}

async function execute(base: Runner, opts: StartOptions): Promise<void> {
  const { log } = base;
  const dataDir = config.dataDir;

  const say = (line: string) => {
    log.append(line);
    opsEvents.emit(HOST_CHANNEL, { type: "panel-update:log", line });
  };

  const step = (name: string) => {
    base.state.step = name;
    writeState(dataDir, base.state);
    emitStatus(base.state);
    say(`\n── ${name} ──`);
  };

  const runner: Runner = { ...base, say, step };
  const { state, checkout } = runner;

  const finish = (phase: PanelUpdateState["phase"], error: string | null): void => {
    state.phase = phase;
    state.error = error;
    state.finishedAt = new Date().toISOString();
    writeState(dataDir, state);
    emitStatus(state);
    if (error) say(`\nERRORE: ${error}`);
    log.flush();
  };

  try {
    const root = checkout.root;
    say(`Aggiornamento di RunPanel in ${root}`);

    // --- Preflight ----------------------------------------------------------
    const probe = await probeAutostart();
    const verdict = canSelfUpdate(probe, process.platform, process.env.NODE_ENV);

    if (!verdict.ok && verdict.restart !== "manual") {
      finish("failed", verdict.reason);
      return;
    }
    if (verdict.restart === "manual" && verdict.reason) say(verdict.reason);

    if (!checkout.isRepo) {
      finish("failed", "Questa installazione non è un checkout git.");
      return;
    }
    if (!checkout.branch || checkout.detached) {
      finish("failed", "HEAD è staccato: non c'è un branch da cui aggiornare.");
      return;
    }
    if (!checkout.remote) {
      finish("failed", "Il checkout non ha un remote origin configurato.");
      return;
    }
    if (!isSecureRemote(checkout.remote)) {
      finish("failed", insecureRemoteReason(checkout.remote));
      return;
    }

    const free = freeBytes(root);
    if (free !== null && free < REQUIRED_FREE_BYTES) {
      finish(
        "failed",
        `Spazio insufficiente: ${formatBytes(free)} liberi, ne servono almeno ${formatBytes(REQUIRED_FREE_BYTES)} ` +
          "per costruire la nuova versione accanto a quella in uso."
      );
      return;
    }

    say(`Branch ${checkout.branch}, remote ${checkout.remote}`);
    say(`Versione in esecuzione: ${checkout.head?.slice(0, 7) ?? "sconosciuta"}`);

    // --- Fetch --------------------------------------------------------------
    step("Scaricamento");
    const token = await getGitHubToken();
    const auth = await gitAuth(token, checkout.remote);
    await fetchRemote(checkout, auth.args, auth.env);

    const target = await remoteHead(checkout);
    if (!target) {
      finish("failed", `Non trovo origin/${checkout.branch} dopo il fetch.`);
      return;
    }

    if (target === checkout.head) {
      say("Già aggiornato: origin non si è mosso.");
      finish("done", null);
      return;
    }

    if (opts.expectedSha && opts.expectedSha !== target) {
      // Not a refusal. A branch that moves between looking and pressing is
      // ordinary, and turning it into an error would make the button a trap
      // that gets harder to press the more active the repository is.
      say(
        `Nota: avevi davanti ${opts.expectedSha.slice(0, 7)}, il branch è ora a ${target.slice(0, 7)}. ` +
          "Procedo con l'ultimo."
      );
    }

    // --- Signature ----------------------------------------------------------
    //
    // Before the store dump and before the reset, so a refusal costs nothing:
    // nothing has been copied and nothing has been moved. The object is already
    // in the object store from the fetch above, which is what makes verifying
    // it here possible at all.
    const signature = await verifySignature(runner, checkout, target, token);
    if (!signature.ok) {
      finish("failed", signature.reason);
      return;
    }

    state.toSha = target;
    writeState(dataDir, state);

    // --- Store dump ---------------------------------------------------------
    //
    // After the fetch, so a panel that turns out to be up to date does not leave
    // a copy of its database behind for nothing.
    step("Copia dello store");
    state.storeBackup = await dumpStore(runner);
    writeState(dataDir, state);

    step("Commit da applicare");
    const incoming = await commitsBehind(checkout);
    say(`${incoming.length} commit da applicare:`);
    for (const commit of incoming) say(`  ${commit.short}  ${commit.subject}`);

    // --- Reset --------------------------------------------------------------
    step("Allineamento del checkout");
    const doomed = await wouldClean(checkout);
    if (doomed.length > 0) {
      say("File non tracciati che verranno rimossi (i .env sono esclusi):");
      for (const entry of doomed) say(`  ${entry}`);
    }

    await resetHard(checkout, `refs/remotes/origin/${checkout.branch}`);
    await cleanUntracked(checkout);
    say(`Checkout allineato a ${target.slice(0, 7)}`);

    // --- The config that decides where the build lands ----------------------
    const configPath = path.join(root, "next.config.ts");
    const configSource = readIfPresent(configPath);
    if (!configSource || !configSupportsStagedBuild(configSource)) {
      await rollbackSource(runner, "next.config.ts della versione scaricata non supporta RUNPANEL_DIST_DIR");
      finish(
        "failed",
        "La versione scaricata costruirebbe direttamente su .next, cioè sopra il pannello in esecuzione. " +
          "Aggiornamento annullato e checkout riportato indietro: aggiorna a mano."
      );
      return;
    }

    // --- Install ------------------------------------------------------------
    step("Installazione delle dipendenze");
    const pm = resolvePackageManager(root, whichSync);
    if (pm.fellBack) {
      say(`Il lockfile indica ${pm.detected}, che non è nel PATH: uso npm.`);
    }
    state.packageManager = pm.manager.cmd;
    writeState(dataDir, state);

    say(`> ${pm.manager.frozenInstall}`);
    try {
      await runCommand(pm.manager.frozenInstall, {
        cwd: root,
        timeout: INSTALL_TIMEOUT_MS,
        onLog: say,
      });
    } catch (err) {
      await rollbackSource(runner, "install non riuscito");
      finish("failed", `Installazione delle dipendenze non riuscita: ${errorText(err)}`);
      return;
    }

    // --- Build --------------------------------------------------------------
    step("Build");
    const staging = path.join(root, STAGING_DIR);
    fs.rmSync(staging, { recursive: true, force: true });

    say("La build parte senza cache, quindi è normale che duri più di una build locale.");
    const buildCommand = `${pm.manager.cmd} run build`;
    say(`> ${buildCommand}   (in ${STAGING_DIR})`);

    const heap = buildHeapEnv();
    if (heap.NODE_OPTIONS) say(`NODE_OPTIONS=${heap.NODE_OPTIONS}`);

    try {
      await runCommand(buildCommand, {
        cwd: root,
        // Through the package manager rather than calling next directly, so the
        // `prebuild` script still runs: it regenerates lib/icons.generated.ts,
        // and an icon added by this very update would otherwise be missing.
        env: { RUNPANEL_DIST_DIR: STAGING_DIR, ...heap },
        timeout: BUILD_TIMEOUT_MS,
        onLog: say,
      });
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      await rollbackSource(runner, "build non riuscita");
      finish("failed", `Build non riuscita: ${errorText(err)}`);
      return;
    }

    const missing = verifyBuild(staging);
    if (missing) {
      fs.rmSync(staging, { recursive: true, force: true });
      await rollbackSource(runner, "build incompleta");
      finish("failed", `La build è uscita senza errori ma è incompleta: ${missing}`);
      return;
    }
    say("Build verificata.");

    // --- Hand over, or swap and go ------------------------------------------
    if (verdict.restart === "manual") {
      const commands = manualCommands(root, verdict.restart);
      // Deliberately stopping *before* the swap. A swapped build with the old
      // process still serving it is a hybrid nobody can use: the running server
      // holds the old manifests in memory and would resolve chunks against the
      // new ones. If it cannot be restarted, it must not be swapped.
      state.manualCommands = commands;
      step("In attesa di un riavvio manuale");
      say("Nuova versione costruita in " + STAGING_DIR + " e pronta. Esegui:");
      for (const command of commands) say(`  ${command}`);
      state.phase = "awaiting-manual";
      state.finishedAt = new Date().toISOString();
      writeState(dataDir, state);
      emitStatus(state);
      log.flush();
      return;
    }

    step("Sostituzione della build");
    const previous = path.join(root, PREVIOUS_DIR);
    const live = path.join(root, LIVE_DIR);

    // Written *before* the renames, not after. Between the two calls below the
    // panel briefly has no build directory at all, and if the process were to
    // die in that window the state file is the only thing that would say where
    // its build went.
    state.distBackup = previous;
    state.manualCommands = rollbackCommands(root, state.fromSha);
    writeState(dataDir, state);

    fs.rmSync(previous, { recursive: true, force: true });
    fs.renameSync(live, previous);
    try {
      fs.renameSync(staging, live);
    } catch (err) {
      // Put the old one back before anything else.
      fs.renameSync(previous, live);
      state.distBackup = null;
      await rollbackSource(runner, "scambio della build non riuscito");
      finish("failed", `Sostituzione della build non riuscita: ${errorText(err)}`);
      return;
    }

    state.phase = "awaiting-restart";
    state.step = "Riavvio";
    state.finishedAt = new Date().toISOString();
    writeState(dataDir, state);
    emitStatus(state);

    say(`Aggiornato a ${target.slice(0, 7)}. Riavvio del pannello in corso.`);
    say("Se non dovesse tornare su, per rimettere la versione precedente:");
    for (const command of state.manualCommands) say(`  ${command}`);
    log.flush();

    restart(runner, verdict.restart);
  } catch (err) {
    finish("failed", errorText(err));
  }
}

/**
 * Leave, so that something else brings the panel back.
 *
 * The exit code is 75 (`EX_TEMPFAIL`) and not 0, and that is the one detail
 * here worth arguing about. systemd's `Restart=always` and the cron script's
 * loop do not care either way, but a container started with
 * `--restart on-failure` — a completely ordinary choice — restarts on a failure
 * and *not* on a clean exit. Exiting non-zero is the only code that means
 * "come back" to all of them.
 *
 * It is also why this does not send itself SIGINT and let Next shut down
 * cleanly: that would hand the exit code to Next, which exits zero.
 */
function restart(runner: Runner, method: RestartMethod): void {
  const banner = [
    "",
    `[RunPanel] Aggiornamento applicato (${runner.state.fromSha?.slice(0, 7)} → ${runner.state.toSha?.slice(0, 7)}).`,
    `[RunPanel] Esco con ${RESTART_EXIT_CODE} per farmi riavviare da ${method}.`,
    "[RunPanel] Se non torno su, la build precedente è in " + PREVIOUS_DIR + ":",
    ...runner.state.manualCommands.map((command) => `[RunPanel]   ${command}`),
    "",
  ].join("\n");

  // stdout, so it lands in the journal. If the panel does not come back this is
  // half of what the operator has; the state file is the other half.
  console.log(banner);

  // Not unref'd, unlike every other timer in this codebase. Those are chores
  // that must not hold the process open; this one is the whole point.
  setTimeout(() => process.exit(RESTART_EXIT_CODE), RESTART_DELAY_MS);
}

/** Put the source tree back where it was. The build directory is untouched. */
async function rollbackSource(runner: Runner, why: string): Promise<void> {
  const { state, checkout, say } = runner;
  if (!state.fromSha) return;

  say(`\nRipristino del checkout a ${state.fromSha.slice(0, 7)} (${why}).`);
  try {
    await resetHard(checkout, state.fromSha);

    /*
      And reinstalling, which is the part that is easy to leave out.

      `next start` reads the *build*, not the sources, so a source tree left
      forward would be harmless on its own — the panel would go on serving the
      old build quite correctly. `node_modules` is the exception: the install
      step already replaced it, and the running build resolves `better-sqlite3`,
      `pg` and Next's own runtime out of it. Leaving the new dependencies under
      the old build is the one genuinely inconsistent state this can produce.
    */
    const pm = resolvePackageManager(checkout.root, whichSync);
    say(`> ${pm.manager.frozenInstall}`);
    await runCommand(pm.manager.frozenInstall, {
      cwd: checkout.root,
      timeout: INSTALL_TIMEOUT_MS,
      onLog: say,
    });
    say("Checkout e dipendenze riportati alla versione precedente.");
  } catch (err) {
    say(`Ripristino non riuscito: ${errorText(err)}`);
    say("Il pannello continua a girare sulla build precedente, che non è stata toccata.");
  }
}

/**
 * A build that exited 0 having produced nothing is a real outcome — an OOM
 * worker, a disk that filled up mid-write — and it is the one thing that must
 * never reach the swap. Three existence checks against a directory nobody has
 * started serving yet.
 */
function verifyBuild(dir: string): string | null {
  if (!fs.existsSync(path.join(dir, "BUILD_ID"))) return "manca BUILD_ID";

  const manifest = path.join(dir, "required-server-files.json");
  if (!fs.existsSync(manifest)) return "manca required-server-files.json";
  try {
    JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch {
    return "required-server-files.json non è JSON valido";
  }

  const serverApp = path.join(dir, "server", "app");
  if (!fs.existsSync(serverApp) || fs.readdirSync(serverApp).length === 0) {
    return "la cartella server/app è vuota";
  }

  return null;
}

/**
 * Refuse to install a commit this host cannot vouch for.
 *
 * Off unless the operator turned it on, and silent when off — no probe, no
 * process, nothing in the log. When it is on, a failure to even read the
 * setting is treated as a refusal rather than as permission: a security control
 * that switches itself off when the database hiccups is not a control.
 */
async function verifySignature(
  runner: Runner,
  checkout: PanelCheckout,
  target: string,
  token: string | null
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let required: boolean;
  try {
    required = await signatureRequired();
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  }
  if (!required) return { ok: true };

  runner.step("Verifica della firma");
  const auth = await gitAuthWithConfig(token, checkout.remote ?? "", await signingConfig());
  const { exitOk, raw } = await verifyCommit(checkout, target, auth.env, auth.args);

  if (signatureAccepted(exitOk, raw)) {
    runner.say(`Firma verificata per ${target.slice(0, 7)}.`);
    return { ok: true };
  }
  return { ok: false, reason: explainVerifyFailure(raw) };
}

/**
 * A copy of the store, taken before anything moves.
 *
 * Migrations run by themselves at boot (`instrumentation.ts` calls `getDb()`),
 * which is convenient right up until one of them fails — and then the panel is
 * down, which means there is no UI from which to restore anything. This costs
 * one statement and is the difference between an afternoon and an evening.
 *
 * `VACUUM INTO` and never a file copy, for the reason spelled out in
 * `services/backup/panel-store.ts`: under WAL a copy silently omits pages that
 * are committed but not yet checkpointed.
 */
async function dumpStore(runner: Runner): Promise<string | null> {
  const env = getEnv();
  if (env.db.driver !== "sqlite") {
    runner.say("Store Postgres: la copia preventiva è a carico del tuo backup abituale.");
    return null;
  }

  const dir = config.panelUpdateDir;
  fs.mkdirSync(dir, { recursive: true });
  // `ensureDataDirs()` already does this at boot; repeated here because this
  // also runs on installations that predate the getter, where the directory was
  // created 0755 by an older RunPanel and would keep that mode forever.
  tighten(dir, 0o700);

  const destination = path.join(dir, `store-${runner.state.runId}.db`);
  fs.rmSync(destination, { force: true });
  pruneStoreDumps(dir, KEEP_STORE_DUMPS - 1);
  // The survivors too, for the same reason: a dump written before this existed
  // is still sitting there readable.
  for (const stale of listStoreDumps(dir)) tighten(path.join(dir, stale.name), 0o600);

  try {
    const db = await getDb();
    await sql`VACUUM INTO ${sql.lit(destination)}`.execute(db);
    // SQLite creates this file, not Node, so there is no `mode` option to pass
    // at the call site the way `services/env-file.ts` does — the chmod is the
    // whole of it. Without it the file lands 0644 with a complete copy of every
    // credential the panel holds.
    tighten(destination, 0o600);

    const { integrity, projects } = await verifySqlite(destination);
    if (integrity !== "ok") {
      // Deleted rather than kept: a corrupt copy that looks like a backup is
      // worse than an obvious absence, because it is only opened on the day it
      // is the last thing left.
      fs.rmSync(destination, { force: true });
      runner.say(`Copia dello store scartata: non supera integrity_check (${integrity}).`);
      return null;
    }

    runner.say(
      `Copia dello store in ${destination} (${formatBytes(fs.statSync(destination).size)}, ` +
        `${integrity}, ${projects} progetti)`
    );
    return destination;
  } catch (err) {
    // Not fatal. A panel that refuses to update because it could not take a
    // precaution is a panel that never updates.
    runner.say(`Copia dello store non riuscita, proseguo comunque: ${errorText(err)}`);
    return null;
  }
}

/**
 * Keep the last few and drop the rest.
 *
 * Each of these is a whole copy of the panel's database, taken on the way into
 * an update and never looked at again once the update works. Without this they
 * accumulate one per update, forever, in the data directory — which is also
 * where the backups live and is the disk most likely to be the small one.
 */
function pruneStoreDumps(dir: string, keep: number): void {
  try {
    for (const stale of listStoreDumps(dir).slice(Math.max(0, keep))) {
      fs.rmSync(path.join(dir, stale.name), { force: true });
    }
  } catch {
    /* housekeeping is never a reason to fail an update */
  }
}

/** Newest first. */
function listStoreDumps(dir: string): Array<{ name: string; at: number }> {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("store-") && name.endsWith(".db"))
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/** Narrow a mode, where the platform has modes to narrow. */
function tighten(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    /* Windows and some network filesystems have no mode bits to set. */
  }
}

function manualCommands(root: string, method: RestartMethod): string[] {
  const swap = [
    `cd ${root}`,
    `rm -rf ${PREVIOUS_DIR} && mv ${LIVE_DIR} ${PREVIOUS_DIR} && mv ${STAGING_DIR} ${LIVE_DIR}`,
  ];

  if (method === "systemd") return [...swap, "sudo systemctl restart runpanel.service"];
  if (method === "container") return [...swap, "docker restart <container>"];
  return [...swap, "# poi riavvia il processo del pannello"];
}

function rollbackCommands(root: string, fromSha: string | null): string[] {
  return [
    `cd ${root}`,
    `rm -rf ${LIVE_DIR} && mv ${PREVIOUS_DIR} ${LIVE_DIR}`,
    ...(fromSha ? [`git reset --hard ${fromSha}`, "npm install"] : []),
  ];
}

function freeBytes(dir: string): number | null {
  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bsize) * Number(stat.bavail);
  } catch {
    return null;
  }
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function errorText(err: unknown): string {
  // Shared with the check, so "the repository is private" reads the same
  // whether it was found by the six-hourly look or by pressing the button.
  //
  // Redacted as well as explained: this lands in `panel-update.json`, in the
  // run log and on the updates page, and an error is exactly the path by which
  // a credential that should never have been in a message travels furthest.
  return redactGitSecrets(explainGitError(err instanceof Error ? err.message : String(err)));
}

// --- What the API needs to know ----------------------------------------------

export interface UpdateBlocker {
  reason: string;
}

/**
 * Whether something else is running that this must not interrupt.
 *
 * `KillMode=process` keeps PM2 and every container alive across the panel's
 * restart, but a project's own `next build` or `docker build` is a direct child
 * of this process and dies with it — halfway through, leaving a deployment row
 * that says `building` forever. A backup is worse: it would leave a partial
 * archive.
 */
export async function updateBlockers(): Promise<UpdateBlocker | null> {
  if (activeBackupRunId()) {
    return { reason: "C'è un backup in corso: aspetta che finisca." };
  }

  const db = await getDb();
  const deploying = await db
    .selectFrom("projects")
    .select(["slug"])
    .where("status", "=", "deploying")
    .execute();

  if (deploying.length > 0) {
    const names = deploying.map((row) => row.slug).join(", ");
    return {
      reason:
        `C'è un deploy in corso (${names}). Il riavvio del pannello lo interromperebbe a metà: ` +
        "aspetta che finisca.",
    };
  }

  return null;
}

/** The last run, whatever became of it. */
export function currentRun(): PanelUpdateState | null {
  return readState(config.dataDir);
}

/** Forget a finished run, so the page stops showing it. */
export function dismissRun(): void {
  const state = readState(config.dataDir);
  if (state && isTerminal(state.phase)) clearState(config.dataDir);
}
