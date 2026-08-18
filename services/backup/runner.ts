import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { getDb, nowIso } from "@/lib/db";
import type {
  BackupArtifactStatus,
  BackupRunStatus,
  BackupTrigger,
  ProjectsTable,
} from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { panelVersion } from "@/lib/version";
import { opsEvents } from "../events";
import { notify } from "../notify";
import { isDockerAvailable } from "../docker/cli";
import { writeArchive } from "./archive";
import { loadDestination } from "./destinations";
import { DumpSkipped, dumpServiceDatabase } from "./dumpers";
import { dumpPanelStore } from "./panel-store";
import { archiveFileName, backupLog, clearStaging, relativeArchivePath, stagingDir } from "./paths";
import {
  exportProjectConfig,
  exportProjectRepo,
  exportProjectVolume,
  listProjectVolumes,
  shouldIncludeRepo,
} from "./project-export";
import { applyRetention } from "./retention";
import type {
  BackupJob,
  BackupManifest,
  BackupTarget,
  JobOutcome,
  RunContext,
  StagedFile,
} from "./types";

/**
 * One backup, start to finish.
 *
 * The shape that matters: a target that fails does not end the run. A night
 * where nine of ten databases were saved is worth having, and a run that aborted
 * on the first unreachable container would have saved none of them. Failures
 * become artifacts with a reason, and the run closes `partial`.
 */

export interface RunRequest {
  trigger: BackupTrigger;
  targets: BackupTarget[];
  destinationId: string;
  policyId?: string | null;
  policyName?: string | null;
  includeSecretKey?: boolean;
  /** Exempt from retention. Safety dumps taken before a restore are. */
  pinned?: boolean;
  signal?: AbortSignal;
}

export interface RunSummary {
  runId: string;
  status: BackupRunStatus;
  ok: number;
  failed: number;
  skipped: number;
  bytes: number;
  error?: string;
}

/**
 * One at a time, process-wide. Dumps are heavy on the same disk and CPU the
 * user's applications are running on, and two of them at once turn a background
 * chore into an outage.
 */
const globalRef = globalThis as typeof globalThis & { __runpanelBackupActive?: string | null };

export function activeBackupRunId(): string | null {
  return globalRef.__runpanelBackupActive ?? null;
}

export class BackupBusyError extends Error {
  constructor() {
    super("Un backup è già in corso");
    this.name = "BackupBusyError";
  }
}

/** Refuse to start rather than fill the disk and take the machine down with it. */
const FREE_SPACE_RESERVE = 2 * 1024 * 1024 * 1024;

function freeBytes(): number | null {
  try {
    const stat = fs.statfsSync(config.backupsDir);
    return Number(stat.bsize) * Number(stat.bavail);
  } catch {
    // Not every filesystem answers. An unknown amount of space is not a reason
    // to refuse to take a backup.
    return null;
  }
}

/**
 * Create the run and return as soon as its row exists, with the work still
 * going.
 *
 * The split matters for one reason: "Esegui ora" has to answer with an id the
 * browser can immediately open a log stream on. Doing the insert first and the
 * dumping after means there is no window where the client holds an id the
 * database has never heard of.
 */
export async function startBackup(
  request: RunRequest
): Promise<{ runId: string; done: Promise<RunSummary> }> {
  if (globalRef.__runpanelBackupActive) throw new BackupBusyError();

  const db = await getDb();
  const runId = generateId();
  const startedAt = new Date();
  const log = backupLog(runId);

  globalRef.__runpanelBackupActive = runId;

  const emit = (line: string) => {
    log.append(line);
    opsEvents.emit(runId, { type: "backup:log", line });
  };

  await db
    .insertInto("backup_runs")
    .values({
      id: runId,
      policy_id: request.policyId ?? null,
      policy_name: request.policyName ?? null,
      trigger: request.trigger,
      status: "running",
      destination_id: request.destinationId,
      archive_path: null,
      archive_bytes: null,
      checksum: null,
      manifest: null,
      error_message: null,
      pinned: request.pinned ? 1 : 0,
      started_at: startedAt.toISOString(),
      finished_at: null,
      heartbeat_at: startedAt.toISOString(),
    })
    .execute();

  opsEvents.emit(runId, { type: "backup:status", status: "running" });

  const done = execute({ runId, request, startedAt, emit, log }).finally(() => {
    globalRef.__runpanelBackupActive = null;
  });

  return { runId, done };
}

/** Start a backup and wait for it. What the scheduler uses. */
export async function runBackup(request: RunRequest): Promise<RunSummary> {
  const { done } = await startBackup(request);
  return done;
}

interface ExecuteArgs {
  runId: string;
  request: RunRequest;
  startedAt: Date;
  emit: (line: string) => void;
  log: { flush: () => void };
}

async function execute({ runId, request, startedAt, emit, log }: ExecuteArgs): Promise<RunSummary> {
  const db = await getDb();

  // A run that hangs on an unresponsive engine should look hung, not finished.
  const heartbeat = setInterval(() => {
    void db
      .updateTable("backup_runs")
      .set({ heartbeat_at: nowIso() })
      .where("id", "=", runId)
      .execute()
      .catch(() => {});
  }, 30_000);
  heartbeat.unref?.();

  const ctx: RunContext = {
    runId,
    stagingDir: stagingDir(runId),
    log: emit,
    signal: request.signal,
  };
  fs.mkdirSync(ctx.stagingDir, { recursive: true });

  let summary: RunSummary = { runId, status: "failed", ok: 0, failed: 0, skipped: 0, bytes: 0 };

  try {
    const free = freeBytes();
    if (free !== null && free < FREE_SPACE_RESERVE) {
      throw new Error(
        `Spazio insufficiente: liberi ${formatBytes(free)}, ne servono almeno ${formatBytes(FREE_SPACE_RESERVE)}`
      );
    }

    emit(`Backup ${runId} — ${request.policyName ?? "esecuzione manuale"}`);
    if (!(await isDockerAvailable())) {
      // Recorded as a failed run, never skipped in silence: a policy that
      // quietly does nothing is worse than one that visibly fails.
      emit("Docker non è raggiungibile: i dump dei container non sono possibili");
    }

    const jobs = await resolveJobs(request.targets, request.includeSecretKey ?? false);
    emit(`${jobs.length} elementi da salvare`);

    const outcomes: JobOutcome[] = [];
    for (const job of jobs) {
      if (request.signal?.aborted) throw new Error("Backup annullato");
      outcomes.push(await runJob(job, ctx));

      const remaining = freeBytes();
      if (remaining !== null && remaining < FREE_SPACE_RESERVE) {
        throw new Error(
          `Spazio esaurito durante il backup: liberi ${formatBytes(remaining)}`
        );
      }
    }

    const ok = outcomes.filter((o) => o.status === "ok");
    const failed = outcomes.filter((o) => o.status === "failed");
    const skipped = outcomes.filter((o) => o.status === "skipped");

    await recordArtifacts(runId, outcomes);

    if (ok.length === 0) {
      throw new Error(
        failed.length > 0
          ? `Nessun elemento salvato: ${failed[0].error ?? "errore sconosciuto"}`
          : "Nessun elemento da salvare"
      );
    }

    const manifest: BackupManifest = {
      schemaVersion: 1,
      runId,
      policyId: request.policyId ?? null,
      policyName: request.policyName ?? null,
      trigger: request.trigger,
      createdAt: startedAt.toISOString(),
      panel: { version: panelVersion(), storeDriver: (await import("@/lib/env")).getEnv().db.driver },
      artifacts: outcomes.map((outcome) => ({
        kind: outcome.kind,
        refId: outcome.refId,
        refName: outcome.refName,
        entryPath: outcome.entryPath,
        bytes: outcome.bytes,
        sha256: outcome.sha256,
        status: outcome.status,
        error: outcome.error,
        meta: outcome.meta,
      })),
    };

    const files: StagedFile[] = outcomes.flatMap((outcome) => outcome.files);
    const fileName = archiveFileName(runId, request.policyName ?? null, startedAt);

    emit(`Creo l'archivio (${files.length} file)…`);
    // Written into staging first, then handed to the destination: for the local
    // destination that hand-off is a rename on the same filesystem, so the
    // archive appears in the catalogue whole or not at all.
    const staged = path.join(ctx.stagingDir, fileName);
    const archive = await writeArchive(staged, files, manifest);

    const destination = await loadDestination(request.destinationId);
    const stored = await destination.put(archive.absolutePath, fileName);
    emit(`Archivio pronto: ${formatBytes(stored.bytes)} — ${stored.ref}`);

    const status: BackupRunStatus = failed.length > 0 ? "partial" : "success";

    await db
      .updateTable("backup_runs")
      .set({
        status,
        archive_path: stored.ref,
        archive_bytes: stored.bytes,
        checksum: archive.sha256,
        manifest: JSON.stringify(manifest),
        finished_at: nowIso(),
        heartbeat_at: nowIso(),
        error_message: failed.length > 0 ? `${failed.length} elementi non salvati` : null,
      })
      .where("id", "=", runId)
      .execute();

    opsEvents.emit(runId, { type: "backup:status", status });

    summary = {
      runId,
      status,
      ok: ok.length,
      failed: failed.length,
      skipped: skipped.length,
      bytes: stored.bytes,
    };

    // Only after a success, and never the newest one: a disk that is full must
    // not be able to delete the last good backup while trying to make room.
    const pruned = await applyRetention(request.policyId ?? null);
    if (pruned > 0) emit(`Retention: rimossi ${pruned} archivi più vecchi`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(`ERRORE: ${message}`);
    summary = { ...summary, status: "failed", error: message };

    await db
      .updateTable("backup_runs")
      .set({
        status: "failed",
        error_message: message,
        finished_at: nowIso(),
        heartbeat_at: nowIso(),
      })
      .where("id", "=", runId)
      .execute();

    opsEvents.emit(runId, { type: "backup:status", status: "failed", message });
  } finally {
    clearInterval(heartbeat);
    clearStaging(runId);
    log.flush();

    /*
      In the `finally`, which is the only line both exits pass through.

      A backup is the one operation whose failure is invisible by design: it
      runs at four in the morning, writes to a directory nobody opens, and the
      day you find out it stopped working is the day you needed it. Success is
      announced too, and deliberately — a channel that only ever speaks up when
      something is wrong teaches you nothing about whether it is still working.
    */
    void notify({
      key: "backup.finished",
      policy: request.policyName ?? null,
      status: summary.status,
      ok: summary.ok,
      failed: summary.failed,
      skipped: summary.skipped,
      bytes: summary.bytes,
      durationMs: Date.now() - startedAt.getTime(),
      error: summary.error ?? null,
    });
  }

  return summary;
}

// --- Turning selectors into work --------------------------------------------

async function resolveJobs(targets: BackupTarget[], includeSecret: boolean): Promise<BackupJob[]> {
  const db = await getDb();
  const jobs: BackupJob[] = [];
  const seen = new Set<string>();

  const push = (job: BackupJob, key: string) => {
    // `all-services` alongside a named service would otherwise dump it twice.
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push(job);
  };

  const addService = async (id: string, databases?: string[]) => {
    const service = await db
      .selectFrom("services")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    if (!service) {
      push(
        {
          kind: "missing",
          targetKind: "service-db",
          refId: id,
          refName: id,
          reason: "Il servizio non esiste più",
        },
        `missing:service:${id}`
      );
      return;
    }

    if (!databases || databases.length === 0) {
      push({ kind: "service-db", service, database: null }, `service:${id}:*`);
      return;
    }
    for (const database of databases) {
      push({ kind: "service-db", service, database }, `service:${id}:${database}`);
    }
  };

  const addProject = async (project: ProjectsTable, include: string[]) => {
    if (include.includes("config")) {
      push({ kind: "project-config", project }, `config:${project.id}`);
    }
    if (shouldIncludeRepo(project, include.includes("repo"))) {
      push({ kind: "project-repo", project }, `repo:${project.id}`);
    }
    if (include.includes("volumes")) {
      const volumes = await listProjectVolumes(project.slug).catch(() => []);
      for (const volume of volumes) {
        push({ kind: "project-volume", project, volume }, `volume:${volume}`);
      }
    }
  };

  for (const target of targets) {
    switch (target.kind) {
      case "panel":
        push({ kind: "panel-store", includeSecret }, "panel");
        break;

      case "service":
        await addService(target.id, target.databases);
        break;

      case "all-services": {
        const services = await db.selectFrom("services").select("id").execute();
        for (const service of services) await addService(service.id);
        break;
      }

      case "project": {
        const project = await db
          .selectFrom("projects")
          .selectAll()
          .where("id", "=", target.id)
          .executeTakeFirst();
        if (!project) {
          push(
            {
              kind: "missing",
              targetKind: "project-config",
              refId: target.id,
              refName: target.id,
              reason: "Il progetto non esiste più",
            },
            `missing:project:${target.id}`
          );
          break;
        }
        await addProject(project, target.include);
        break;
      }

      case "all-projects": {
        const projects = await db.selectFrom("projects").selectAll().execute();
        for (const project of projects) await addProject(project, target.include);
        break;
      }
    }
  }

  return jobs;
}

// --- Running one job ---------------------------------------------------------

function describe(job: BackupJob): { refId: string | null; refName: string } {
  switch (job.kind) {
    case "service-db":
      return {
        refId: job.service.id,
        refName: job.database ? `${job.service.name} / ${job.database}` : job.service.name,
      };
    case "panel-store":
      return { refId: null, refName: "Store del pannello" };
    case "project-config":
      return { refId: job.project.id, refName: `${job.project.slug} — configurazione` };
    case "project-repo":
      return { refId: job.project.id, refName: `${job.project.slug} — repository` };
    case "project-volume":
      return { refId: job.project.id, refName: `${job.project.slug} — volume ${job.volume}` };
    case "missing":
      return { refId: job.refId, refName: job.refName };
  }
}

function artifactKind(job: BackupJob) {
  return job.kind === "missing" ? job.targetKind : job.kind;
}

async function runJob(job: BackupJob, ctx: RunContext): Promise<JobOutcome> {
  const { refId, refName } = describe(job);
  const kind = artifactKind(job);

  const outcome = (
    status: BackupArtifactStatus,
    extra: Partial<JobOutcome> = {}
  ): JobOutcome => ({
    kind,
    refId,
    refName,
    status,
    entryPath: "",
    files: [],
    bytes: 0,
    sha256: null,
    ...extra,
  });

  if (job.kind === "missing") {
    ctx.log(`— ${refName}: ${job.reason}`);
    opsEvents.emit(ctx.runId, {
      type: "backup:artifact",
      label: refName,
      status: "skipped",
      error: job.reason,
    });
    return outcome("skipped", { error: job.reason });
  }

  try {
    const produced = await produce(job, ctx);
    opsEvents.emit(ctx.runId, {
      type: "backup:artifact",
      label: refName,
      status: "ok",
      bytes: produced.bytes,
    });
    return outcome("ok", produced);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: BackupArtifactStatus = err instanceof DumpSkipped ? "skipped" : "failed";
    ctx.log(`${status === "skipped" ? "—" : "✗"} ${refName}: ${message}`);
    opsEvents.emit(ctx.runId, {
      type: "backup:artifact",
      label: refName,
      status,
      error: message,
    });
    return outcome(status, { error: message });
  }
}

async function produce(
  job: Exclude<BackupJob, { kind: "missing" }>,
  ctx: RunContext
): Promise<Pick<JobOutcome, "entryPath" | "files" | "bytes" | "sha256" | "meta">> {
  switch (job.kind) {
    case "service-db": {
      const dump = await dumpServiceDatabase(job.service, job.database, ctx);
      return {
        entryPath: dump.entryPath,
        files: [dump],
        bytes: dump.bytes,
        sha256: dump.sha256,
        meta: dump.meta,
      };
    }

    case "panel-store": {
      const dump = await dumpPanelStore(ctx, job.includeSecret);
      const primary = dump.files[0];
      return {
        entryPath: primary.entryPath,
        files: dump.files,
        bytes: dump.files.reduce((total, file) => total + file.bytes, 0),
        sha256: primary.sha256,
        meta: dump.meta,
      };
    }

    case "project-config": {
      const exported = await exportProjectConfig(job.project, ctx);
      return {
        entryPath: exported.files[0].entryPath,
        files: exported.files,
        bytes: exported.files.reduce((total, file) => total + file.bytes, 0),
        sha256: exported.files[0].sha256,
        meta: exported.meta,
      };
    }

    case "project-repo": {
      const exported = await exportProjectRepo(job.project, ctx);
      return {
        // A tree, so the artifact points at the prefix its entries share.
        entryPath: `projects/${job.project.slug}/repo/`,
        files: exported.files,
        bytes: exported.files.reduce((total, file) => total + file.bytes, 0),
        sha256: null,
        meta: exported.meta,
      };
    }

    case "project-volume": {
      const exported = await exportProjectVolume(job.project, job.volume, ctx);
      return {
        entryPath: exported.file.entryPath,
        files: [exported.file],
        bytes: exported.file.bytes,
        sha256: exported.file.sha256,
        meta: exported.meta,
      };
    }
  }
}

async function recordArtifacts(runId: string, outcomes: JobOutcome[]): Promise<void> {
  if (outcomes.length === 0) return;

  const db = await getDb();
  const now = nowIso();

  await db
    .insertInto("backup_artifacts")
    .values(
      outcomes.map((outcome) => ({
        id: generateId(),
        run_id: runId,
        kind: outcome.kind,
        ref_id: outcome.refId,
        ref_name: outcome.refName,
        entry_path: outcome.entryPath,
        bytes: outcome.bytes,
        checksum: outcome.sha256,
        status: outcome.status,
        error_message: outcome.error ?? null,
        meta: outcome.meta ? JSON.stringify(outcome.meta) : null,
        created_at: now,
      }))
    )
    .execute();
}

export { relativeArchivePath };
