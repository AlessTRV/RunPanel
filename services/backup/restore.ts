import fs from "fs";
import path from "path";
import { decrypt, encrypt } from "@/lib/crypto";
import { config } from "@/lib/config";
import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable, ServicesTable } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { generateId } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { docker, dockerFromFile, dockerTry } from "../docker/cli";
import { opsEvents } from "../events";
import { processManager } from "../process-manager";
import { databaseAdmin, execArgs, serviceTarget } from "../service-databases";
import { containerMounts } from "../docker/volumes";
import { extractArchiveEntry, isSafeEntryPath, listArchiveEntries } from "./archive-read";
import { buildDestination } from "./destinations";
import { assertBackupId, restoreLog } from "./paths";
import { startBackup } from "./runner";
import type { BackupTarget } from "./types";

/**
 * Putting a backup back.
 *
 * This is the only part of the panel that can destroy production data, so the
 * shape is defensive on purpose:
 *
 *  - a safety backup of exactly what is about to be overwritten runs first, and
 *    **if it fails the restore stops** unless someone explicitly said otherwise;
 *  - the target's engine has to match the artifact's, checked here and not only
 *    in the browser;
 *  - anything that had to be stopped is started again in a `finally`, so a
 *    failure never leaves applications down;
 *  - the panel's own store is never restored underneath the running process.
 */

export interface RestoreMapping {
  artifactId: string;
  action: "restore" | "skip";
  /** Which service or project to put it into. Defaults to where it came from. */
  targetId?: string;
  targetDatabase?: string;
}

export interface RestoreRequest {
  runId?: string;
  uploadId?: string;
  mappings: RestoreMapping[];
  skipSafetyBackup?: boolean;
}

export class RestoreBusyError extends Error {
  constructor() {
    super("Un ripristino è già in corso");
    this.name = "RestoreBusyError";
  }
}

const globalRef = globalThis as typeof globalThis & { __runpanelRestoreActive?: string | null };


/** Where an artifact is unpacked before it is fed to an engine. */
function restoreStaging(restoreId: string): string {
  return path.join(config.backupStagingDir, `restore-${assertBackupId(restoreId)}`);
}

export async function startRestore(
  request: RestoreRequest
): Promise<{ restoreId: string; done: Promise<void> }> {
  if (globalRef.__runpanelRestoreActive) throw new RestoreBusyError();

  const db = await getDb();
  const restoreId = generateId();
  const now = nowIso();

  await db
    .insertInto("restore_runs")
    .values({
      id: restoreId,
      run_id: request.runId ?? null,
      source: request.uploadId ? "upload" : "catalog",
      archive_path: null,
      targets: JSON.stringify(request.mappings),
      safety_run_id: null,
      status: "running",
      error_message: null,
      started_at: now,
      finished_at: null,
      heartbeat_at: now,
    })
    .execute();

  globalRef.__runpanelRestoreActive = restoreId;
  opsEvents.emit(restoreId, { type: "restore:status", status: "running" });

  const done = execute(restoreId, request).finally(() => {
    globalRef.__runpanelRestoreActive = null;
  });

  return { restoreId, done };
}

async function execute(restoreId: string, request: RestoreRequest): Promise<void> {
  const db = await getDb();
  const log = restoreLog(restoreId);
  const emit = (line: string) => {
    log.append(line);
    opsEvents.emit(restoreId, { type: "restore:log", line });
  };

  const staging = restoreStaging(restoreId);
  fs.mkdirSync(staging, { recursive: true });

  /** Projects this restore stopped, and has to start again whatever happens. */
  const stopped: { slug: string; runtime: string }[] = [];
  let failure: string | null = null;

  try {
    const archive = await resolveArchive(request, emit);
    emit(`Archivio: ${path.basename(archive)} (${formatBytes(fs.statSync(archive).size)})`);

    const artifacts = await loadArtifacts(request);
    const planned = request.mappings.filter((mapping) => mapping.action === "restore");
    if (planned.length === 0) throw new Error("Nessun elemento selezionato");

    emit(`${planned.length} element${planned.length === 1 ? "o" : "i"} da ripristinare`);

    // The single most valuable step: a copy of exactly what is about to be
    // overwritten, taken before anything is touched and exempt from retention.
    if (!request.skipSafetyBackup) {
      const safetyId = await takeSafetyBackup(planned, artifacts, emit);
      if (safetyId) {
        await db
          .updateTable("restore_runs")
          .set({ safety_run_id: safetyId })
          .where("id", "=", restoreId)
          .execute();
      }
    } else {
      emit("ATTENZIONE: backup di sicurezza saltato su richiesta esplicita");
    }

    for (const mapping of planned) {
      const artifact = artifacts.get(mapping.artifactId);
      if (!artifact) {
        emit(`— elemento ${mapping.artifactId} non presente nell'archivio, lo salto`);
        continue;
      }
      await restoreArtifact(artifact, mapping, archive, staging, emit, stopped);
    }

    emit("Ripristino completato");
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    emit(`ERRORE: ${failure}`);
  } finally {
    // Whatever happened, nothing stays down because of us.
    //
    // `restart` rather than `start`: the container or the PM2 entry still
    // exists, it is merely stopped, so this needs none of the deploy contract —
    // no working directory, no environment, no port. Rebuilding that here would
    // be a second, quietly diverging copy of the deploy pipeline.
    for (const project of stopped) {
      try {
        emit(`Riavvio ${project.slug}…`);
        await processManager.restart(project.slug, project.runtime);
      } catch (err) {
        emit(`Non sono riuscito a riavviare ${project.slug}: ${(err as Error).message}`);
      }
    }

    fs.rmSync(staging, { recursive: true, force: true });
    log.flush();

    await db
      .updateTable("restore_runs")
      .set({
        status: failure ? "failed" : "success",
        error_message: failure,
        finished_at: nowIso(),
        heartbeat_at: nowIso(),
      })
      .where("id", "=", restoreId)
      .execute();

    opsEvents.emit(restoreId, {
      type: "restore:status",
      status: failure ? "failed" : "success",
      ...(failure ? { message: failure } : {}),
    });
  }
}

// --- Finding the archive and what is in it -----------------------------------

async function resolveArchive(
  request: RestoreRequest,
  emit: (line: string) => void
): Promise<string> {
  if (request.uploadId) {
    const file = path.join(config.backupUploadsDir, `${assertBackupId(request.uploadId)}.zip`);
    if (!fs.existsSync(file)) throw new Error("L'archivio caricato non è più disponibile");
    emit("Sorgente: archivio caricato");
    return file;
  }

  if (!request.runId) throw new Error("Nessuna sorgente indicata");

  const db = await getDb();
  const run = await db
    .selectFrom("backup_runs")
    .selectAll()
    .where("id", "=", assertBackupId(request.runId))
    .executeTakeFirst();

  if (!run?.archive_path || !run.destination_id) {
    throw new Error("Questo backup non ha un archivio da cui ripristinare");
  }

  const destinationRow = await db
    .selectFrom("backup_destinations")
    .selectAll()
    .where("id", "=", run.destination_id)
    .executeTakeFirst();

  if (!destinationRow) throw new Error("La destinazione di quel backup non è più configurata");

  const destination = buildDestination(destinationRow);
  const stat = await destination.stat(run.archive_path);
  if (!stat.exists) throw new Error("L'archivio non è più su disco");

  emit(`Sorgente: backup del ${new Date(run.started_at).toLocaleString()}`);
  // The local destination hands back a path-backed stream; for anything else we
  // would have to spool it first. Only local exists today, so this stays simple.
  return (await import("./paths")).resolveArchivePath(run.archive_path);
}

export interface RestorableArtifact {
  id: string;
  kind: string;
  refId: string | null;
  refName: string;
  entryPath: string;
  bytes: number;
  meta: Record<string, unknown>;
}

async function loadArtifacts(request: RestoreRequest): Promise<Map<string, RestorableArtifact>> {
  const db = await getDb();

  if (request.runId) {
    const rows = await db
      .selectFrom("backup_artifacts")
      .selectAll()
      .where("run_id", "=", request.runId)
      .where("status", "=", "ok")
      .execute();

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          kind: row.kind,
          refId: row.ref_id,
          refName: row.ref_name,
          entryPath: row.entry_path,
          bytes: row.bytes,
          meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {},
        },
      ])
    );
  }

  throw new Error("Il ripristino da archivio caricato richiede prima un'ispezione");
}


// --- The safety copy ---------------------------------------------------------

async function takeSafetyBackup(
  mappings: RestoreMapping[],
  artifacts: Map<string, RestorableArtifact>,
  emit: (line: string) => void
): Promise<string | null> {
  const targets: BackupTarget[] = [];
  const seen = new Set<string>();

  for (const mapping of mappings) {
    const artifact = artifacts.get(mapping.artifactId);
    if (!artifact) continue;

    const id = mapping.targetId ?? artifact.refId;
    if (!id) {
      if (artifact.kind === "panel-store" && !seen.has("panel")) {
        seen.add("panel");
        targets.push({ kind: "panel" });
      }
      continue;
    }

    if (artifact.kind === "service-db" && !seen.has(`s:${id}`)) {
      seen.add(`s:${id}`);
      targets.push({ kind: "service", id });
    }
    if (artifact.kind.startsWith("project-") && !seen.has(`p:${id}`)) {
      seen.add(`p:${id}`);
      targets.push({ kind: "project", id, include: ["config", "volumes"] });
    }
  }

  if (targets.length === 0) return null;

  emit("Backup di sicurezza di quello che sto per sovrascrivere…");

  const { defaultDestinationId } = await import("./destinations");
  const destinationId = await defaultDestinationId();
  if (!destinationId) throw new Error("Nessuna destinazione per il backup di sicurezza");

  const { done, runId } = await startBackup({
    trigger: "pre-restore",
    targets,
    destinationId,
    policyName: "Sicurezza pre-ripristino",
    pinned: true,
  });

  const summary = await done;
  if (summary.status === "failed") {
    // Refusing here is the whole point: without a copy, a restore that goes
    // wrong has nothing to go back to.
    throw new Error(
      `Il backup di sicurezza è fallito (${summary.error ?? "motivo sconosciuto"}). ` +
        "Il ripristino è stato annullato."
    );
  }

  emit(`Backup di sicurezza pronto: ${runId} (${formatBytes(summary.bytes)})`);
  return runId;
}

// --- Restoring one artifact ---------------------------------------------------

async function restoreArtifact(
  artifact: RestorableArtifact,
  mapping: RestoreMapping,
  archive: string,
  staging: string,
  emit: (line: string) => void,
  stopped: { slug: string; runtime: string }[]
): Promise<void> {
  emit(`→ ${artifact.refName}`);

  switch (artifact.kind) {
    case "service-db":
      return restoreDatabase(artifact, mapping, archive, staging, emit);
    case "panel-store":
      return restorePanelStore(artifact, archive, emit);
    case "project-config":
      return restoreProjectConfig(artifact, mapping, archive, staging, emit);
    case "project-volume":
      return restoreVolume(artifact, mapping, archive, staging, emit, stopped);
    case "project-repo":
      return restoreRepo(artifact, mapping, archive, emit);
    default:
      throw new Error(`Non so ripristinare un elemento di tipo "${artifact.kind}"`);
  }
}

async function extract(archive: string, entryPath: string, staging: string): Promise<string> {
  if (!isSafeEntryPath(entryPath)) {
    throw new Error(`Nome di file rifiutato nell'archivio: ${entryPath}`);
  }
  const destination = path.join(staging, entryPath);
  await extractArchiveEntry(archive, entryPath, destination);
  return destination;
}

async function requireService(id: string, expectedType: string): Promise<ServicesTable> {
  const db = await getDb();
  const service = await db
    .selectFrom("services")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!service) throw new Error("Il servizio di destinazione non esiste più");
  if (expectedType && service.type !== expectedType) {
    // Checked here and not only in the browser: a mismatched engine would
    // either fail confusingly or, worse, half-apply.
    throw new Error(
      `Il backup è di un ${expectedType}, la destinazione è un ${service.type}`
    );
  }
  return service;
}

async function restoreDatabase(
  artifact: RestorableArtifact,
  mapping: RestoreMapping,
  archive: string,
  staging: string,
  emit: (line: string) => void
): Promise<void> {
  const engine = String(artifact.meta.engine ?? "");
  const service = await requireService(mapping.targetId ?? artifact.refId ?? "", engine);
  const target = serviceTarget(service);
  const file = await extract(archive, artifact.entryPath, staging);

  if (engine === "postgresql") {
    // pg_dumpall and pg_dump --create both carry their own DROP/CREATE, so the
    // restore connects to `postgres` and lets the script do the rest.
    await dockerFromFile(
      [
        ...execArgs(target, { PGPASSWORD: target.credentials.password }),
        "psql",
        "-v", "ON_ERROR_STOP=1",
        "-U", target.credentials.user,
        "-d", "postgres",
      ],
      file,
      { decompress: true, onStderr: (line) => emit(`  ${line}`) }
    );
  } else if (engine === "mysql") {
    await dockerFromFile(
      [...execArgs(target, { MYSQL_PWD: target.credentials.password }), "mysql", "-u", "root"],
      file,
      { decompress: true, onStderr: (line) => emit(`  ${line}`) }
    );
    // Some versions' --all-databases includes the `mysql` schema itself, and
    // the grants it just rewrote are not live until this runs.
    await dockerTry(
      [
        ...execArgs(target, { MYSQL_PWD: target.credentials.password }),
        "mysql", "-u", "root", "-e", "FLUSH PRIVILEGES",
      ],
      { timeout: 30_000 }
    );
  } else if (engine === "mongodb") {
    await dockerFromFile(
      [
        ...execArgs(target, {}),
        "mongorestore",
        "--archive",
        "--gzip",
        "--drop",
        "-u", target.credentials.user,
        "-p", target.credentials.password,
        "--authenticationDatabase", "admin",
      ],
      file,
      // mongodump already gzipped it, and mongorestore is being told to expect
      // that — decompressing on our side would hand it the wrong thing.
      { decompress: false, onStderr: (line) => emit(`  ${line}`) }
    );
  } else if (engine === "redis") {
    await restoreRedis(service, file, emit);
  } else {
    throw new Error(`Motore "${engine}" non supportato per il ripristino`);
  }

  const admin = databaseAdmin(service.type);
  if (admin.supported) {
    // Show what is actually there afterwards rather than asserting success.
    const databases = await admin.list(target).catch(() => []);
    emit(`  database presenti: ${databases.join(", ") || "nessuno"}`);
  }
}

/**
 * Redis is genuinely different: an RDB cannot be loaded into a running server.
 *
 * The order matters and the AOF is the trap — a Redis with append-only enabled
 * rebuilds from the AOF at boot and ignores the RDB entirely, so a restore that
 * only replaced dump.rdb would appear to do nothing at all.
 */
async function restoreRedis(
  service: ServicesTable,
  file: string,
  emit: (line: string) => void
): Promise<void> {
  // Asked, not re-derived. This used to rebuild the volume name from the
  // service name with `projectSlug: null`, so for a Redis inside a project it
  // named `runpanel-redis-<nome>` while the data was in
  // `runpanel-redis-<slug>-<nome>`. `docker run -v` then *created* that empty
  // volume, wrote the dump into it, and the container restarted on the real
  // one: a restore that restored nothing, reported success, and left no trace.
  // Docker knows where the data is mounted — and it keeps knowing once a
  // service can be moved to a host directory.
  const mounts = await containerMounts(service.container_name);
  const data = mounts.find((mount) => mount.destination === "/data");
  const source = data?.name || data?.source;
  if (!source) throw new Error("Non riesco a determinare dove questo Redis tiene i dati");

  emit(`  dati in ${source}`);
  emit("  fermo il servizio…");
  await docker(["stop", service.container_name], { timeout: 60_000 });

  try {
    await dockerFromFile(
      [
        "run", "--rm", "-i",
        "-v", `${source}:/data`,
        "redis:" + service.version,
        "sh", "-c",
        "rm -f /data/appendonly.aof; rm -rf /data/appendonlydir; cat > /data/dump.rdb",
      ],
      file,
      { decompress: true, onStderr: (line) => emit(`  ${line}`) }
    );
  } finally {
    emit("  riavvio il servizio…");
    await docker(["start", service.container_name], { timeout: 60_000 });
  }
}

/**
 * The panel's own store.
 *
 * SQLite is swapped in at the next boot, by `instrumentation.ts`, because a file
 * the process has open cannot be replaced underneath it. Postgres is refused
 * outright: restoring the database you are running on is a stop-the-world
 * operation, and pretending otherwise produces half-restored panels.
 */
async function restorePanelStore(
  artifact: RestorableArtifact,
  archive: string,
  emit: (line: string) => void
): Promise<void> {
  const env = getEnv();

  if (env.db.driver !== "sqlite") {
    throw new Error(
      "Lo store Postgres del pannello non si ripristina da qui. Ferma RunPanel ed esegui " +
        "pg_restore --clean --if-exists sul dump contenuto nell'archivio: il comando esatto è " +
        "nel LEGGIMI.txt dentro l'archivio stesso."
    );
  }

  const pending = path.join(config.dataDir, "runpanel.restored.db");
  await extractArchiveEntry(archive, artifact.entryPath, pending);
  fs.writeFileSync(path.join(config.dataDir, ".restore-pending"), nowIso(), { mode: 0o600 });

  emit(
    "  store estratto. Verrà messo in servizio al prossimo riavvio del pannello, " +
      "e quello attuale sarà conservato come runpanel.db.pre-restore-<data>."
  );
}

async function restoreProjectConfig(
  artifact: RestorableArtifact,
  mapping: RestoreMapping,
  archive: string,
  staging: string,
  emit: (line: string) => void
): Promise<void> {
  const file = await extract(archive, artifact.entryPath, staging);
  const payload = JSON.parse(decrypt(fs.readFileSync(file, "utf8"))) as {
    project: ProjectsTable;
    envVars: { key: string; value: string }[];
  };

  const db = await getDb();
  const targetId = mapping.targetId ?? payload.project.id;

  const existing = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", targetId)
    .executeTakeFirst();

  if (!existing) throw new Error("Il progetto di destinazione non esiste più");

  // One transaction: a configuration applied halfway is worse than one not
  // applied at all, because nothing says which half.
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("projects")
      .set({
        builder_config: payload.project.builder_config,
        port: payload.project.port,
        runtime_type: payload.project.runtime_type,
        source_type: payload.project.source_type,
        source_url: payload.project.source_url,
        source_branch: payload.project.source_branch,
        app_name: payload.project.app_name,
        // The archive describes a configuration, and a pin is not part of one —
        // it is where this installation happened to hold the project. Left in
        // place, the restored configuration would go out built from a commit
        // that has nothing to do with it.
        pinned_sha: null,
        pinned_at: null,
        updated_at: nowIso(),
      })
      .where("id", "=", targetId)
      .execute();

    await trx.deleteFrom("env_vars").where("project_id", "=", targetId).execute();

    if (payload.envVars.length > 0) {
      await trx
        .insertInto("env_vars")
        .values(
          payload.envVars.map((variable) => ({
            id: generateId(),
            project_id: targetId,
            key: variable.key,
            // Re-encrypted with this panel's key, which may not be the one that
            // produced the archive.
            value: encrypt(variable.value),
            created_at: nowIso(),
          }))
        )
        .execute();
    }
  });

  emit(`  configurazione e ${payload.envVars.length} variabili ripristinate`);
}

async function restoreVolume(
  artifact: RestorableArtifact,
  mapping: RestoreMapping,
  archive: string,
  staging: string,
  emit: (line: string) => void,
  stopped: { slug: string; runtime: string }[]
): Promise<void> {
  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", mapping.targetId ?? artifact.refId ?? "")
    .executeTakeFirst();

  if (!project) throw new Error("Il progetto di destinazione non esiste più");

  const volume = String(artifact.meta.volume ?? "");
  if (!volume) throw new Error("L'elemento non dice a quale volume appartiene");

  const { listProjectVolumes } = await import("./project-export");
  const owned = await listProjectVolumes(project.slug);
  if (!owned.includes(volume)) {
    throw new Error(`Il volume "${volume}" non risulta di ${project.slug}`);
  }

  const file = await extract(archive, artifact.entryPath, staging);

  // Writing into a volume a running container has mounted is how you get a
  // half-updated dataset, so the project goes down first and comes back in the
  // caller's `finally`.
  if (!stopped.some((entry) => entry.slug === project.slug)) {
    emit(`  fermo ${project.slug}…`);
    await processManager.stop(project.slug, project.runtime_type).catch(() => {});
    stopped.push({ slug: project.slug, runtime: project.runtime_type });
  }

  await dockerFromFile(
    [
      "run", "--rm", "-i",
      "-v", `${volume}:/to`,
      "alpine",
      "sh", "-c",
      // The glob patterns cover dotfiles too; without the second one a restore
      // leaves the previous contents' hidden files behind.
      "rm -rf /to/* /to/..?* /to/.[!.]* 2>/dev/null; tar -xf - -C /to",
    ],
    file,
    { decompress: true, onStderr: (line) => emit(`  ${line}`) }
  );

  emit(`  volume ${volume} ripristinato`);
}

async function restoreRepo(
  artifact: RestorableArtifact,
  mapping: RestoreMapping,
  archive: string,
  emit: (line: string) => void
): Promise<void> {
  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", mapping.targetId ?? artifact.refId ?? "")
    .executeTakeFirst();

  if (!project) throw new Error("Il progetto di destinazione non esiste più");

  const prefix = String(artifact.meta.prefix ?? artifact.entryPath);
  const entries = (await listArchiveEntries(archive)).filter((entry) =>
    entry.entryPath.startsWith(prefix)
  );

  if (entries.length === 0) throw new Error("Nessun file di repository nell'archivio");

  const destination = path.join(config.reposDir, project.slug);
  fs.mkdirSync(destination, { recursive: true });

  let written = 0;
  for (const entry of entries) {
    const relative = entry.entryPath.slice(prefix.length);
    if (!relative || !isSafeEntryPath(relative)) continue;
    await extractArchiveEntry(archive, entry.entryPath, path.join(destination, relative));
    written++;
  }

  emit(`  ${written} file ripristinati in ${destination}`);
}
