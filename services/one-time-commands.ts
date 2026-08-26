import fs from "fs";
import { getDb, nowIso, rowCount } from "@/lib/db";
import type { OneTimeCommandsTable, ProjectsTable } from "@/lib/db/schema";
import type { DeployContract } from "@/lib/deploy-contract";
import {
  deployPhases,
  phaseAvailable,
  phaseLabel,
  phaseRunsInContainer,
  phaseUnavailableReason,
  type DeployPhase,
} from "@/lib/deploy-phases";
import { generateId } from "@/lib/utils";
import { redactGitSecrets } from "@/lib/redact";
import { runCommand } from "./builders/run-command";
import { joinScript, runReleaseCommand } from "./deploy-steps";

/**
 * Commands an operator wants run exactly once, at a chosen point of a deploy.
 *
 * The whole design turns on one property: a row is handed to **one** deploy and
 * to no other. That is bought with a conditional UPDATE — the same idiom
 * `deploy-queue.claim()` uses — issued BEFORE anything is read back. Claiming
 * first and selecting by `deployment_id` afterwards is what makes it race-free
 * without a transaction, which matters because Kysely's transactions over
 * better-sqlite3 are synchronous and this codebase keeps them off the hot path.
 *
 * The guarantee is therefore **at least once**, not exactly once: a panel that
 * dies between spawning a command and writing its outcome will offer that
 * command again. Repeating a migration is the lesser harm next to recording one
 * as done that may never have happened, and `attempts` is raised before the
 * spawn so the queue can say which rows were interrupted rather than untouched.
 */

/** Anything longer than this is a service, not a chore. Matches the release command. */
const COMMAND_TIMEOUT_MS = 600_000;

/** How much history a project shows before the sweep in `docker/gc.ts` gets to it. */
export const HISTORY_PAGE = 50;

export interface OneTimeCommandView {
  id: string;
  phase: DeployPhase;
  command: string;
  label: string | null;
  continueOnError: boolean;
  status: OneTimeCommandsTable["status"];
  attempts: number;
  deploymentId: string | null;
  commitSha: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /**
   * Why this row cannot run as the project is configured now, or null.
   *
   * Derived rather than stored: it is a fact about the project's *current*
   * runtime, and a column would go stale the moment that runtime changed —
   * which is precisely the case it exists to describe.
   */
  blockedReason: string | null;
}

export interface OneTimeCommandInput {
  id?: string;
  phase: DeployPhase;
  command: string;
  label?: string | null;
  continueOnError: boolean;
}

function toView(row: OneTimeCommandsTable, runtimeType: string): OneTimeCommandView {
  return {
    id: row.id,
    phase: row.phase as DeployPhase,
    command: row.command,
    label: row.label,
    continueOnError: row.continue_on_error === 1,
    status: row.status,
    attempts: row.attempts,
    deploymentId: row.deployment_id,
    commitSha: row.commit_sha,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    blockedReason: phaseUnavailableReason(row.phase as DeployPhase, runtimeType),
  };
}

/** What the log and the panel call a command. */
function nameOf(row: Pick<OneTimeCommandsTable, "label" | "command">): string {
  const label = row.label?.trim();
  if (label) return label;
  const firstLine = joinScript(row.command).split(" && ")[0] ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine || "senza nome";
}

// --- reading -----------------------------------------------------------------

export async function queuedForProject(
  projectId: string,
  runtimeType: string
): Promise<OneTimeCommandView[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("one_time_commands")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("status", "in", ["queued", "claimed"])
    .orderBy("position")
    .orderBy("created_at")
    .execute();
  return rows.map((row) => toView(row, runtimeType));
}

export async function historyForProject(
  projectId: string,
  runtimeType: string,
  limit = HISTORY_PAGE
): Promise<OneTimeCommandView[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("one_time_commands")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("status", "in", ["done", "failed"])
    .orderBy("finished_at", "desc")
    .limit(limit)
    .execute();
  return rows.map((row) => toView(row, runtimeType));
}

/** Whether a deploy currently holds any of this project's commands. */
export async function hasClaimed(projectId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .selectFrom("one_time_commands")
    .select("id")
    .where("project_id", "=", projectId)
    .where("status", "=", "claimed")
    .executeTakeFirst();
  return Boolean(row);
}

// --- writing -----------------------------------------------------------------

/**
 * Replace a project's queue with the list the editor sent.
 *
 * Not a blind delete-and-insert: a row that comes back with its `id` is UPDATED
 * in place, keeping `attempts` and the note left by the attempt that failed.
 * Without that, fixing a typo in a command that had already failed once would
 * hand back a row looking as though it had never been tried.
 *
 * Only `queued` rows are ever touched. History is immutable here, and a row a
 * deploy is holding is not this route's to move — the caller refuses the whole
 * request while one exists.
 */
export async function replaceQueue(
  projectId: string,
  runtimeType: string,
  inputs: OneTimeCommandInput[]
): Promise<OneTimeCommandView[]> {
  const db = await getDb();
  const now = nowIso();

  return db.transaction().execute(async (trx) => {
    /*
      Read inside the transaction, and every write below carries
      `status = 'queued'`.

      The caller refuses this request when a deploy already holds a row, but
      that check is a separate round trip: a claim landing between it and here
      would meet an UPDATE and a DELETE that matched on `id` alone. The UPDATE
      rewrote the text of a command the deploy was already executing — so the
      old one ran and the history recorded the new one — and the DELETE removed
      the row while its command ran anyway, leaving no trace at all. The
      predicate makes a claimed row simply invisible to this function, which
      turns the 409 back into a courtesy instead of the only defence.
    */
    const existing = await trx
      .selectFrom("one_time_commands")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("status", "=", "queued")
      .execute();
    const byId = new Map(existing.map((row) => [row.id, row]));

    const kept = new Set<string>();

    for (const [index, input] of inputs.entries()) {
      const previous = input.id ? byId.get(input.id) : undefined;
      const label = input.label?.trim() ? input.label.trim() : null;

      if (previous) {
        kept.add(previous.id);
        await trx
          .updateTable("one_time_commands")
          .set({
            phase: input.phase,
            command: input.command,
            label,
            continue_on_error: input.continueOnError ? 1 : 0,
            position: index,
          })
          .where("id", "=", previous.id)
          .where("status", "=", "queued")
          .execute();
        continue;
      }

      await trx
        .insertInto("one_time_commands")
        .values({
          id: generateId(),
          project_id: projectId,
          phase: input.phase,
          command: input.command,
          label,
          continue_on_error: input.continueOnError ? 1 : 0,
          status: "queued",
          position: index,
          attempts: 0,
          deployment_id: null,
          commit_sha: null,
          error_message: null,
          started_at: null,
          finished_at: null,
          created_at: now,
        })
        .execute();
    }

    const dropped = existing.filter((row) => !kept.has(row.id)).map((row) => row.id);
    if (dropped.length > 0) {
      await trx
        .deleteFrom("one_time_commands")
        .where("id", "in", dropped)
        .where("status", "=", "queued")
        .execute();
    }

    const rows = await trx
      .selectFrom("one_time_commands")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("status", "in", ["queued", "claimed"])
      .orderBy("position")
      .orderBy("created_at")
      .execute();
    return rows.map((row) => toView(row, runtimeType));
  });
}

export async function clearHistory(projectId: string): Promise<number> {
  const db = await getDb();
  const result = await db
    .deleteFrom("one_time_commands")
    .where("project_id", "=", projectId)
    .where("status", "in", ["done", "failed"])
    .executeTakeFirst();
  return rowCount(result);
}

// --- running -----------------------------------------------------------------

export interface ClaimedCommands {
  deploymentId: string;
  /** How many rows this deploy is holding. */
  total: number;
  byPhase: Map<DeployPhase, OneTimeCommandsTable[]>;
}

/**
 * Take everything queued for this project and bind it to this deploy.
 *
 * Rows whose phase does not exist for the project's current runtime are left
 * alone on purpose. Claiming them would produce a zombie: never reached, never
 * consumed, released at the end and claimed again by every deploy after it,
 * silently, forever. Not claiming them keeps the row in the queue with the
 * reason attached, which is a state somebody can act on.
 */
export async function claimForDeploy(
  project: Pick<ProjectsTable, "id" | "runtime_type">,
  deploymentId: string,
  onLog: (line: string) => void
): Promise<ClaimedCommands> {
  const db = await getDb();
  const runnable = deployPhases.filter((phase) => phaseAvailable(phase, project.runtime_type));

  // Claim BEFORE reading. Select-then-update would let two claimers see the
  // same rows; reading back by `deployment_id` cannot.
  await db
    .updateTable("one_time_commands")
    .set({ status: "claimed", deployment_id: deploymentId, started_at: null, finished_at: null })
    .where("project_id", "=", project.id)
    .where("status", "=", "queued")
    .where("phase", "in", runnable)
    .execute();

  const rows = await db
    .selectFrom("one_time_commands")
    .selectAll()
    .where("deployment_id", "=", deploymentId)
    .where("status", "=", "claimed")
    .orderBy("position")
    .orderBy("created_at")
    .execute();

  const byPhase = new Map<DeployPhase, OneTimeCommandsTable[]>();
  for (const row of rows) {
    const phase = row.phase as DeployPhase;
    const list = byPhase.get(phase) ?? [];
    list.push(row);
    byPhase.set(phase, list);
  }

  if (rows.length > 0) {
    onLog(`${rows.length} comando/i una tantum in coda per questo deploy.`);
  }

  // Say out loud what was left behind, and why. Silence here reads as "there
  // was nothing", which is the one thing it does not mean.
  const blocked = await db
    .selectFrom("one_time_commands")
    .selectAll()
    .where("project_id", "=", project.id)
    .where("status", "=", "queued")
    .execute();
  for (const row of blocked) {
    const reason = phaseUnavailableReason(row.phase as DeployPhase, project.runtime_type);
    onLog(
      `Il comando una tantum "${nameOf(row)}" resta in coda: ${reason ?? "fase sconosciuta."}`
    );
  }

  return { deploymentId, total: rows.length, byPhase };
}

export interface PhaseContext {
  runtimeType: string;
  slug: string;
  /**
   * The repository directory — always, in every phase.
   *
   * Deliberately not `buildResult.artifactDir`, which is what the release
   * command gets: for a static project that is `dist/`, and a one-time chore is
   * a chore against the project, not against the folder that ends up served.
   */
  projectDir: string;
  /** The built image, from the post-build phases on. Null before it exists. */
  image: string | null;
  env: Record<string, string>;
  contract: DeployContract;
  commitSha: string | null;
  onLog: (line: string) => void;
}

/**
 * Run everything this deploy claimed for one phase.
 *
 * Throws on the first critical failure, which is what fails the deploy — the
 * same contract the release command has. The failing row is put back in the
 * queue *before* the throw, so its lifecycle is already settled no matter who
 * catches the exception; the builders, notably, turn it into a build error.
 */
export async function runPhase(
  phase: DeployPhase,
  claimed: ClaimedCommands,
  ctx: PhaseContext
): Promise<void> {
  const rows = claimed.byPhase.get(phase);
  if (!rows || rows.length === 0) return;

  const db = await getDb();

  // `pre-deploy` is the one phase that can land before the checkout exists, and
  // `runCommand` rejects on a missing cwd. Say what is happening and leave the
  // rows claimed — the release at the end of the deploy puts them back.
  if (!fs.existsSync(ctx.projectDir)) {
    ctx.onLog(`\n--- One-time commands (${phase}) ---`);
    ctx.onLog(`Nessuna cartella di progetto ancora: ${rows.length} comando/i restano in coda.`);
    return;
  }

  const inContainer = phaseRunsInContainer(phase, ctx.runtimeType) && Boolean(ctx.image);
  ctx.onLog(`\n--- One-time commands (${phase}) ---`);
  ctx.onLog(
    inContainer
      ? "Girano in un container usa-e-getta creato dall'immagine appena costruita."
      : `Girano sull'host, in ${ctx.projectDir}.`
  );

  for (const row of rows) {
    const script = joinScript(row.command);
    const name = nameOf(row);

    if (!script) {
      await db
        .updateTable("one_time_commands")
        .set({ status: "done", finished_at: nowIso(), commit_sha: ctx.commitSha })
        .where("id", "=", row.id)
        .execute();
      continue;
    }

    // Written before the spawn, not after: it is what lets crash recovery tell
    // "was interrupted" apart from "never started".
    await db
      .updateTable("one_time_commands")
      .set({ started_at: nowIso(), attempts: row.attempts + 1, finished_at: null })
      .where("id", "=", row.id)
      .execute();

    try {
      if (inContainer && ctx.image) {
        await runReleaseCommand(row.command, {
          runtimeType: ctx.runtimeType,
          slug: ctx.slug,
          projectDir: ctx.projectDir,
          image: ctx.image,
          env: ctx.env,
          contract: ctx.contract,
          onLog: ctx.onLog,
        });
      } else {
        ctx.onLog(`> ${script}`);
        await runCommand(script, {
          cwd: ctx.projectDir,
          env: ctx.env,
          timeout: COMMAND_TIMEOUT_MS,
          onLog: ctx.onLog,
        });
      }
    } catch (err: unknown) {
      // Redacted here and not only in the pipeline's catch: that one covers the
      // critical path, but a "continua comunque" failure is written straight to
      // the row and rendered in the panel without ever passing through it.
      const message = redactGitSecrets(
        err instanceof Error ? err.message : "Comando una tantum non riuscito"
      );

      if (row.continue_on_error === 1) {
        await db
          .updateTable("one_time_commands")
          .set({
            status: "failed",
            finished_at: nowIso(),
            commit_sha: ctx.commitSha,
            error_message: message,
          })
          .where("id", "=", row.id)
          .execute();
        ctx.onLog(
          `ATTENZIONE: comando una tantum "${name}" non riuscito — il deploy continua. ${message}`
        );
        continue;
      }

      // Back in the queue rather than consumed: the deploy is about to fail, so
      // nothing this command was preparing for actually happened, and the next
      // deploy should try it again.
      await db
        .updateTable("one_time_commands")
        .set({ status: "queued", finished_at: nowIso(), error_message: message })
        .where("id", "=", row.id)
        .execute();

      throw new Error(
        `Comando una tantum "${name}" (${phaseLabel(phase)}) non riuscito: ${message}`
      );
    }

    await db
      .updateTable("one_time_commands")
      .set({
        status: "done",
        finished_at: nowIso(),
        commit_sha: ctx.commitSha,
        error_message: null,
      })
      .where("id", "=", row.id)
      .execute();
    ctx.onLog(`Comando una tantum "${name}" completato.`);
  }
}

/**
 * Put back everything this deploy took and never reached.
 *
 * A no-op after a deploy that ran every phase. After one that failed early it
 * is what stops the rest of the queue from being swallowed by a run that never
 * got to it. Never throws: a queue that could not be released is not a deploy
 * that failed.
 */
export async function releaseUnrun(deploymentId: string): Promise<number> {
  try {
    const db = await getDb();
    const result = await db
      .updateTable("one_time_commands")
      .set({ status: "queued", deployment_id: null })
      .where("deployment_id", "=", deploymentId)
      .where("status", "=", "claimed")
      .executeTakeFirst();
    return rowCount(result);
  } catch (err) {
    console.error(`[one-time] Rilascio della coda non riuscito per ${deploymentId}:`, err);
    return 0;
  }
}
