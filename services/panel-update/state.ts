import fs from "fs";
import path from "path";

/**
 * What the panel was in the middle of when it went down, written where it can
 * be found without the panel.
 *
 * A file rather than a row, and the reason is the same one `store-swap.ts`
 * gives for its marker: this has to be written *synchronously, immediately
 * before the process exits*, and read at the next boot *before* anything opens
 * the database. A run that ends by killing the process cannot report its own
 * outcome through the process it killed.
 *
 * It is also the only thing left if the panel does not come back. So it carries
 * the literal commands to undo the update, and those same commands are printed
 * to stdout — the journal — on the way out. Two places to find them, neither of
 * which needs a working panel.
 *
 * Node builtins only, no imports from the rest of the app: `instrumentation.ts`
 * reads this before `getDb()`, and the unit suite loads the file directly.
 */

export type UpdatePhase =
  /** Working: fetching, installing, building. Nothing swapped yet. */
  | "running"
  /** Built and swapped; the process is on its way out and should come back. */
  | "awaiting-restart"
  /** Built but NOT swapped, because this host has nothing to restart it. */
  | "awaiting-manual"
  | "done"
  | "failed";

export interface PanelUpdateState {
  runId: string;
  phase: UpdatePhase;
  /** Human label of the step in progress, for the page and the log. */
  step: string | null;
  branch: string | null;
  fromSha: string | null;
  toSha: string | null;
  packageManager: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** When the process that applied the update came back up. */
  bootedAt: string | null;
  error: string | null;
  /** Absolute path of the pre-update store dump, when one was taken. */
  storeBackup: string | null;
  /** Absolute path of the previous build, kept until the next boot settles it. */
  distBackup: string | null;
  /** Commands the operator has to run themselves, if any. */
  manualCommands: string[];
}

const FILE = "panel-update.json";

export function stateFile(dataDir: string): string {
  return path.join(dataDir, FILE);
}

export function isTerminal(phase: UpdatePhase): boolean {
  return phase === "done" || phase === "failed";
}

export function readState(dataDir: string): PanelUpdateState | null {
  try {
    const raw = fs.readFileSync(stateFile(dataDir), "utf8");
    const parsed = JSON.parse(raw) as PanelUpdateState;
    return parsed && typeof parsed.runId === "string" ? parsed : null;
  } catch {
    // Absent is the ordinary case: no update has ever been run here.
    return null;
  }
}

/**
 * Written synchronously, always.
 *
 * Every caller is either about to exit the process or about to do something
 * that could kill it, and a state file that lands a tick later is a state file
 * that does not land.
 */
export function writeState(dataDir: string, state: PanelUpdateState): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(stateFile(dataDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function clearState(dataDir: string): void {
  fs.rmSync(stateFile(dataDir), { force: true });
}

/**
 * What a run in progress means once a *new* process is reading it.
 *
 * The whole trick of the update is that arriving here at all is the proof it
 * worked: the only way this code runs is a process that started, which is a
 * process that loaded the build that was swapped in.
 *
 *  - `awaiting-restart` → the restart happened. Done.
 *  - `running` → the process died mid-update, before it ever swapped anything.
 *    The build on disk is the old one, so nothing is broken, but the run will
 *    never finish and must not spin forever in the UI.
 *  - `awaiting-manual` → left deliberately for a human. Untouched, because the
 *    human has not done it yet; the panel that just booted is still the old one.
 *
 * Pure, so the unit suite can walk every transition without a filesystem.
 */
export function settleOnBoot(state: PanelUpdateState, now: string): PanelUpdateState {
  if (state.phase === "awaiting-restart") {
    return { ...state, phase: "done", finishedAt: state.finishedAt ?? now, bootedAt: now };
  }

  if (state.phase === "running") {
    return {
      ...state,
      phase: "failed",
      finishedAt: now,
      bootedAt: now,
      error:
        "Interrotto da un riavvio del pannello prima che l'aggiornamento fosse applicato. " +
        "La versione in esecuzione è quella di prima.",
    };
  }

  return state;
}

/**
 * Close out whatever the previous process left behind. Called from
 * `instrumentation.ts` before the store is opened.
 *
 * Returns the settled state so the caller can log it, or null when there is
 * nothing to settle.
 */
export function settlePanelUpdate(dataDir: string, now = new Date()): PanelUpdateState | null {
  const state = readState(dataDir);
  if (!state || isTerminal(state.phase)) return state;

  const settled = settleOnBoot(state, now.toISOString());
  if (settled === state) return state;

  try {
    writeState(dataDir, settled);
  } catch (err) {
    console.error("[panel-update] Impossibile aggiornare lo stato al boot:", err);
  }

  return settled;
}

/**
 * Throw away the previous build, a minute after boot.
 *
 * Not immediately and not synchronously: it is hundreds of megabytes, and the
 * first request should not wait behind it. Not at all until the panel has
 * actually come back, either — until this code runs, `.next-old` is the only
 * way back.
 */
export function scheduleDistCleanup(dir: string): void {
  const timer = setTimeout(() => {
    fs.rm(dir, { recursive: true, force: true }, (err) => {
      if (err) console.warn(`[panel-update] Build precedente non rimossa (${dir}):`, err.message);
    });
  }, 60_000);
  timer.unref?.();
}
