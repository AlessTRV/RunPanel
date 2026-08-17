import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { nativePathSchema } from "@/lib/validation";
import { projectEvents, type MountPhase } from "./events";
import { AppendLogFile, logPathFor, readLogFile } from "./log-file";
import { processManager } from "./process-manager";
import { getRepoPath } from "./git-manager";
import { restartFromLastDeployment } from "./project-restart";

/**
 * Putting a native project's checkout on a different disk.
 *
 * A project under PM2 has no container, so it has no binds — what it has is
 * `data/repos/<slug>`, and no way to move it. This moves it, and **leaves a
 * symlink behind**.
 *
 * The symlink is the whole design, and it was chosen after checking the two
 * things that could have made it dangerous:
 *
 *  - `lib/fs-safe.ts` resolves the *root* with `realpath` before comparing, so
 *    the file manager's containment check follows a symlinked root instead of
 *    rejecting the project's own files;
 *  - `services/backup/project-export.ts` walks from the root with `readdirSync`,
 *    which traverses it — the skip for symlinks applies to entries inside the
 *    tree, not to the root, so a backup still contains the files.
 *
 * With those two established, nothing else has to change: the twelve places
 * that build `<reposDir>/<slug>` from a slug keep working, including the ones
 * that only ever had a slug, and including the absolute paths already stored in
 * `deployments.artifact_dir` and in the static builder's start command.
 *
 * The copy uses `fs` and not a throwaway container, which is the opposite of the
 * service side and for a concrete reason: a PM2 project runs as a child of the
 * panel, so they share a filesystem by construction. There is no namespace to
 * cross, and no image to borrow.
 */

export interface RepoMoveJournal {
  id: string;
  phase: MountPhase;
  from: string;
  to: string | null;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  rolledBack?: boolean;
  /** The old copy, kept until the operator says the new one is good. */
  leftBehind?: string;
}

export class RepoMoveRefused extends Error {
  constructor(
    readonly code:
      | "runtime-not-native"
      | "move-in-progress"
      | "same-location"
      | "no-repo"
      | "destination-not-empty"
      | "insufficient-space"
      | "inside-data-dir",
    message: string,
    readonly entries?: string[]
  ) {
    super(message);
    this.name = "RepoMoveRefused";
  }
}

const ASIDE_SUFFIX = ".prima-dello-spostamento";

export function parseRepoMove(raw: string | null): RepoMoveJournal | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RepoMoveJournal;
  } catch {
    return null;
  }
}

const TERMINAL: MountPhase[] = ["done", "failed"];
export const isMoveInFlight = (journal: RepoMoveJournal | null): boolean =>
  Boolean(journal && !TERMINAL.includes(journal.phase));

/**
 * Where the checkout really is.
 *
 * `realpath` and not the column: the filesystem is the authority, the column is
 * what the panel intended. They differ exactly when something went wrong, which
 * is when the page most needs to be honest.
 */
export function repoLocation(slug: string): { declared: string; real: string | null } {
  const declared = getRepoPath(slug);
  try {
    return { declared, real: fs.realpathSync(declared) };
  } catch {
    return { declared, real: null };
  }
}

export function moveLogPath(projectId: string): string {
  return logPathFor(path.join(config.logsDir, "project-repo"), projectId);
}

export function moveLog(projectId: string, tailLines = 500): string {
  return readLogFile(moveLogPath(projectId), tailLines);
}

/** Every entry, so "is it empty" and "what is in it" are one question. */
function entriesOf(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name !== "lost+found");
  } catch {
    return [];
  }
}

function sizeOf(dir: string): number {
  let total = 0;
  const walk = (current: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(current, item.name);
      // Not followed: a link inside a checkout points wherever it points, and
      // measuring through it would count somebody else's disk.
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) walk(full);
      else if (item.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* a file that vanished mid-walk is not worth failing over */
        }
      }
    }
  };
  walk(dir);
  return total;
}

async function writeJournal(projectId: string, journal: RepoMoveJournal): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("projects")
    .set({ repo_move: JSON.stringify(journal), updated_at: nowIso() })
    .where("id", "=", projectId)
    .execute();
}

const inFlight = new Set<string>();

/**
 * Validate, then move in the background.
 *
 * Everything that can refuse does so before anything is touched, so a refusal
 * leaves the project exactly as it was.
 */
export async function startRepoMove(
  project: ProjectsTable,
  target: string | null
): Promise<RepoMoveJournal> {
  if (project.runtime_type === "docker" || project.runtime_type === "compose") {
    throw new RepoMoveRefused(
      "runtime-not-native",
      "Questo progetto gira in un container: i suoi file stanno nell'immagine, non in una cartella da spostare."
    );
  }

  if (inFlight.has(project.id) || isMoveInFlight(parseRepoMove(project.repo_move))) {
    throw new RepoMoveRefused("move-in-progress", "Uno spostamento è già in corso.");
  }

  if (target !== null) {
    const parsed = nativePathSchema.safeParse(target);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Percorso non valido");
    target = parsed.data;

    const own = path.resolve(config.dataDir);
    if (path.resolve(target) === own || path.resolve(target).startsWith(own + path.sep)) {
      throw new RepoMoveRefused(
        "inside-data-dir",
        "È dentro la cartella dati del pannello, che è esattamente il disco da cui volevi spostarlo."
      );
    }
  }

  const link = getRepoPath(project.slug);
  const current = repoLocation(project.slug).real;
  if (!current || !fs.existsSync(current)) {
    throw new RepoMoveRefused("no-repo", "Non c'è nessun checkout su disco da spostare.");
  }

  const destination = target ?? path.join(config.reposDir, `${project.slug}${ASIDE_SUFFIX}-restore`);
  const finalDestination = target ?? link;

  if (path.resolve(current) === path.resolve(finalDestination)) {
    throw new RepoMoveRefused("same-location", "Il checkout è già lì.");
  }

  if (target !== null) {
    const existing = entriesOf(destination);
    if (existing.length > 0) {
      throw new RepoMoveRefused(
        "destination-not-empty",
        `${destination} non è vuota: contiene ${existing.slice(0, 5).join(", ")}${existing.length > 5 ? "…" : ""}.`,
        existing
      );
    }
  }

  const journal: RepoMoveJournal = {
    id: generateId(),
    phase: "checking",
    from: current,
    to: target,
    startedAt: nowIso(),
  };

  await writeJournal(project.id, journal);
  inFlight.add(project.id);

  void runMove(project, journal, current, finalDestination).finally(() => {
    inFlight.delete(project.id);
  });

  return journal;
}

async function runMove(
  project: ProjectsTable,
  journal: RepoMoveJournal,
  from: string,
  to: string
): Promise<void> {
  const file = new AppendLogFile(moveLogPath(project.id));
  const emit = (line: string) => {
    file.append(`${nowIso()} ${line}`);
    projectEvents.emit(project.id, { type: "mount:log", line });
  };

  const phase = async (value: MountPhase, error?: string) => {
    journal.phase = value;
    if (error) journal.error = error;
    if (value === "done" || value === "failed") journal.finishedAt = nowIso();
    await writeJournal(project.id, journal);
    projectEvents.emit(project.id, { type: "mount:phase", phase: value, error });
  };

  const link = getRepoPath(project.slug);
  const aside = `${link}${ASIDE_SUFFIX}`;
  const wasRunning = project.status === "running";
  const db = await getDb();

  /*
    The two directions are not symmetric, and getting that wrong is a copy onto
    itself.

    Going out, the destination is a fresh path and the link takes the old one's
    place afterwards. Coming back, the destination *is* the old path — which is
    currently a symlink pointing at the source, so the link has to go first or
    `cp` is handed the same directory twice.
  */
  const returning = path.resolve(to) === path.resolve(link);
  let linkRemoved = false;
  let moved = false;

  try {
    emit(`Sposto il checkout da ${from} a ${to}`);

    await phase("stopping");
    if (wasRunning) {
      emit("Fermo il processo…");
      // Windows cannot replace a file a running process has mapped, and a native
      // addon always is. Stopping is not politeness here, it is what makes the
      // copy possible at all.
      await processManager.stop(project.slug, project.runtime_type).catch(() => {
        /* a process that is already down is the state we wanted */
      });
    }

    await phase("seeding");
    const bytes = sizeOf(from);
    emit(`Da copiare: ${Math.round(bytes / 1024 / 1024)} MB`);

    if (returning) {
      // Removing it first is safe: it is only a link, and the directory it
      // pointed at is the source, which nothing here writes to.
      if (fs.lstatSync(link).isSymbolicLink()) {
        fs.rmSync(link, { force: true });
        linkRemoved = true;
      }
    }

    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    emit("Copia completata.");

    await phase("verifying");
    // A checkout that cannot show its own `.git` has not arrived. Checked only
    // when the source had one — an uploaded ZIP legitimately does not.
    if (fs.existsSync(path.join(from, ".git")) && !fs.existsSync(path.join(to, ".git"))) {
      throw new Error("Nella copia manca `.git`: il checkout non è arrivato intero.");
    }
    const beforeCount = entriesOf(from).length;
    const afterCount = entriesOf(to).length;
    if (afterCount < beforeCount) {
      throw new Error(`In cima c'erano ${beforeCount} voci, nella copia ne risultano ${afterCount}.`);
    }

    await phase("recreating");
    if (!returning) {
      // Aside rather than deleted: until the operator has looked at the new
      // copy, the old one is the only thing that can put this back.
      fs.rmSync(aside, { recursive: true, force: true });
      if (fs.lstatSync(link).isSymbolicLink()) fs.rmSync(link, { force: true });
      else fs.renameSync(link, aside);
      moved = true;

      // `junction` on Windows, which needs no privilege for a directory; a plain
      // directory symlink everywhere else.
      fs.symlinkSync(to, link, process.platform === "win32" ? "junction" : "dir");
      emit(`${link} adesso punta a ${to}`);
    }

    await db
      .updateTable("projects")
      .set({ repo_path: journal.to, updated_at: nowIso() })
      .where("id", "=", project.id)
      .execute();

    if (wasRunning) {
      emit("Riavvio il progetto…");
      await restartFromLastDeployment(project.id);
    } else {
      emit("Il progetto era fermo: resta fermo.");
    }

    // Coming back, what is left behind is the operator's own directory, outside
    // `<reposDir>` — recorded so the page can say where it is, but not offered
    // for deletion: `deletePreviousCheckout` refuses anything the panel did not
    // create itself.
    journal.leftBehind = returning ? from : fs.existsSync(aside) ? aside : undefined;
    emit(journal.leftBehind ? `La copia precedente resta in ${journal.leftBehind}.` : "Fatto.");
    await phase("done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(`Errore: ${message}`);

    await phase("rolling-back");
    emit("Rimetto il checkout dov'era…");
    try {
      if (moved) {
        try {
          if (fs.lstatSync(link).isSymbolicLink()) fs.rmSync(link, { force: true });
        } catch {
          /* nothing there to undo */
        }
        if (fs.existsSync(aside)) fs.renameSync(aside, link);
      } else if (linkRemoved) {
        // The return direction failed after the link was taken away. The source
        // was never written to, so pointing at it again restores exactly what
        // was there.
        fs.rmSync(link, { recursive: true, force: true });
        fs.symlinkSync(from, link, process.platform === "win32" ? "junction" : "dir");
      }
      if (wasRunning) await restartFromLastDeployment(project.id);
      journal.rolledBack = true;
      emit("Il progetto è di nuovo com'era.");
    } catch (rollbackErr) {
      journal.rolledBack = false;
      emit(
        `Anche il ritorno indietro è fallito: ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`
      );
    }

    await phase("failed", message);
  } finally {
    file.flush();
  }
}

/**
 * Delete the copy the move left behind, once the operator says the new one is
 * good.
 *
 * Bounded, unlike the service side's host directory: this one is always inside
 * `<reposDir>`, created by the panel and named by the panel, so removing it is
 * the panel's to do.
 */
export async function deletePreviousCheckout(project: ProjectsTable): Promise<{ removed: string }> {
  const journal = parseRepoMove(project.repo_move);
  const aside = journal?.leftBehind;
  if (!journal || journal.phase !== "done" || !aside) {
    throw new RepoMoveRefused("no-repo", "Non c'è niente da eliminare.");
  }

  const root = path.resolve(config.reposDir);
  if (!path.resolve(aside).startsWith(root + path.sep)) {
    throw new RepoMoveRefused("no-repo", "La copia precedente non è dove il pannello l'aveva lasciata.");
  }

  fs.rmSync(aside, { recursive: true, force: true });

  delete journal.leftBehind;
  await writeJournal(project.id, journal);
  return { removed: aside };
}
