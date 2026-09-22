/**
 * The Docker side of backing up and restoring a project's volumes.
 *
 * Every call goes through an injected `DockerCli`, and nothing here imports a
 * value from the rest of the panel. That is what lets the unit suite drive the
 * whole sequence against a simulated daemon — which containers get stopped,
 * in which order, and what is never touched — without a real one, and without
 * letting a test loose on a machine full of somebody else's containers.
 */

import crypto from "crypto";
import fs from "fs";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGzip } from "zlib";
import type { PreBackupCommand, VolumeConsistency } from "../../lib/backup-settings";

export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
export const COMPOSE_VOLUME_LABEL = "com.docker.compose.volume";
export const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

export interface DockerCli {
  /** Resolves with the output; rejects on a non-zero exit. */
  run(args: string[], opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }>;
  /** Stream stdout straight to a file. */
  toFile(
    args: string[],
    destination: string,
    opts: { compress: boolean; signal?: AbortSignal; onStderr?: (line: string) => void }
  ): Promise<{ bytes: number; rawBytes: number; sha256: string }>;
  /** Feed a file to stdin — the restore direction. */
  fromFile(
    args: string[],
    source: string,
    opts: { decompress: boolean; onStderr?: (line: string) => void }
  ): Promise<void>;
}

/**
 * How a project's resources are recognised. Built by the caller from
 * `ownedFilters()` and `composeProjectName()`, which stay the single definition
 * of what RunPanel owns.
 */
export interface ProjectOwner {
  slug: string;
  /** `runpanel-<slug>`: the only handle a Compose stack carries. */
  composeProject: string;
  /** `--filter` arguments selecting RunPanel's labelled volumes of this project. */
  runpanelFilters: string[];
  /** The label RunPanel writes the project slug into. */
  projectLabel: string;
}

export interface ProjectVolume {
  name: string;
  /** Labelled by RunPanel itself, or created by the project's Compose stack. */
  origin: "runpanel" | "compose";
  /** The volume's name inside the compose file, e.g. `db-data`. */
  composeVolume: string | null;
}

function splitLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Every volume that belongs to the project.
 *
 * Compose refuses `--label` on `up`, so a stack's volumes carry only Compose's
 * own labels and never matched the RunPanel filter: a project on the Compose
 * runtime was backed up without any of its data. They are recognised here by
 * `com.docker.compose.project`. Both labels are compared again in code, whole,
 * rather than trusted from the daemon's filter: `runpanel-shop` must never
 * collect the volumes of `runpanel-shop2`.
 */
export async function discoverVolumes(cli: DockerCli, owner: ProjectOwner): Promise<ProjectVolume[]> {
  const labelled = await cli.run([
    "volume", "ls", ...owner.runpanelFilters,
    "--format", `{{.Name}}\t{{.Label "${owner.projectLabel}"}}`,
  ]);
  const stack = await cli.run([
    "volume", "ls",
    "--filter", `label=${COMPOSE_PROJECT_LABEL}=${owner.composeProject}`,
    "--format", `{{.Name}}\t{{.Label "${COMPOSE_PROJECT_LABEL}"}}\t{{.Label "${COMPOSE_VOLUME_LABEL}"}}`,
  ]);

  const found = new Map<string, ProjectVolume>();
  for (const line of splitLines(labelled.stdout)) {
    const [name, project] = line.split("\t");
    if (!name || project !== owner.slug) continue;
    found.set(name, { name, origin: "runpanel", composeVolume: null });
  }
  for (const line of splitLines(stack.stdout)) {
    const [name, project, volume] = line.split("\t");
    if (!name || project !== owner.composeProject) continue;
    // A volume carrying both kinds of label is RunPanel's; it keeps that origin.
    if (!found.has(name)) found.set(name, { name, origin: "compose", composeVolume: volume || null });
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// --- Who is using a volume -----------------------------------------------------

export interface ContainerInfo {
  id: string;
  name: string;
  /** Docker's `State.Status`: running, paused, restarting, exited, created… */
  state: string;
  composeProject: string;
  composeService: string;
  runpanelProject: string;
  /** Named volumes only, with whether each is mounted read-write. */
  mounts: { name: string; rw: boolean }[];
}

/*
  `{{with}}` rather than a bare `{{index}}`: a missing label prints
  `<no value>` otherwise, which is a perfectly valid-looking project name.
*/
function inspectFormat(projectLabel: string): string {
  const label = (key: string) => `{{with index .Config.Labels "${key}"}}{{.}}{{end}}`;
  return [
    "{{.Id}}",
    "{{.Name}}",
    "{{.State.Status}}",
    label(COMPOSE_PROJECT_LABEL),
    label(COMPOSE_SERVICE_LABEL),
    label(projectLabel),
    '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}={{.RW}};{{end}}{{end}}',
  ].join("|");
}

function parseContainer(line: string): ContainerInfo | null {
  const [id, name, state, composeProject, composeService, runpanelProject, mounts] = line.split("|");
  if (!id) return null;
  return {
    id,
    name: (name ?? "").replace(/^\//, ""),
    state: state ?? "",
    composeProject: composeProject ?? "",
    composeService: composeService ?? "",
    runpanelProject: runpanelProject ?? "",
    mounts: (mounts ?? "")
      .split(";")
      .filter(Boolean)
      .map((entry) => {
        const eq = entry.lastIndexOf("=");
        return { name: entry.slice(0, eq), rw: entry.slice(eq + 1) === "true" };
      }),
  };
}

/**
 * One inspect for the whole batch, and one per container only if that fails:
 * a batch fails whole when a single container disappeared between the listing
 * and the inspect, and that one is simply no longer a concern.
 */
export async function inspectContainers(
  cli: DockerCli,
  ids: string[],
  owner: ProjectOwner
): Promise<ContainerInfo[]> {
  if (ids.length === 0) return [];
  const format = inspectFormat(owner.projectLabel);

  let lines: string[];
  try {
    lines = splitLines((await cli.run(["inspect", "--format", format, ...ids])).stdout);
  } catch {
    lines = [];
    for (const id of ids) {
      try {
        lines.push(...splitLines((await cli.run(["inspect", "--format", format, id])).stdout));
      } catch {
        /* gone since the listing */
      }
    }
  }
  return lines.map(parseContainer).filter((info): info is ContainerInfo => info !== null);
}

export function isOwned(container: ContainerInfo, owner: ProjectOwner): boolean {
  return container.composeProject === owner.composeProject || container.runpanelProject === owner.slug;
}

export interface VolumeUser extends ContainerInfo {
  rw: boolean;
  owned: boolean;
}

/**
 * The containers that have the volume mounted, with how.
 *
 * `--filter volume=` narrows the listing and nothing more: the name is checked
 * again against each container's mounts, whole, because the filter matches more
 * loosely than its name suggests on some engines.
 */
export async function volumeUsers(
  cli: DockerCli,
  volume: string,
  owner: ProjectOwner,
  opts: { all?: boolean } = {}
): Promise<VolumeUser[]> {
  const listed = await cli.run([
    "ps", ...(opts.all ? ["-a"] : []), "-q", "--no-trunc", "--filter", `volume=${volume}`,
  ]);
  const containers = await inspectContainers(cli, splitLines(listed.stdout), owner);

  const users: VolumeUser[] = [];
  for (const container of containers) {
    const mount = container.mounts.find((entry) => entry.name === volume);
    if (!mount) continue;
    users.push({ ...container, rw: mount.rw, owned: isOwned(container, owner) });
  }
  return users;
}

/** The services of the project's Compose stack, from the containers that exist. */
export async function stackServices(cli: DockerCli, owner: ProjectOwner): Promise<string[]> {
  const listed = await cli.run([
    "ps", "-a", "-q", "--no-trunc", "--filter", `label=${COMPOSE_PROJECT_LABEL}=${owner.composeProject}`,
  ]);
  const services = new Set<string>();
  for (const container of await inspectContainers(cli, splitLines(listed.stdout), owner)) {
    if (container.composeProject === owner.composeProject && container.composeService) {
      services.add(container.composeService);
    }
  }
  return [...services].sort();
}

/** States in which a container can still touch its volumes. */
const ACTIVE_STATES = new Set(["running", "paused", "restarting"]);

function messageOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

function megabytes(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1).replace(".", ",")} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

// --- The command run before the copy --------------------------------------------

export interface PreBackupOutcome {
  service: string;
  container: string | null;
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * The project's own way of making its data safe to copy — an SQLite
 * `.backup`, a `pg_dump` into the volume, a flush — run in one service of its
 * stack. It never throws: whether a failure is fatal depends on whether the
 * writers are going to be paused anyway, which is the caller's to decide.
 */
export async function runPreBackup(
  cli: DockerCli,
  owner: ProjectOwner,
  hook: PreBackupCommand,
  log: (line: string) => void
): Promise<PreBackupOutcome> {
  const started = Date.now();
  let container: string | null = null;
  try {
    const listed = await cli.run([
      "ps", "-q", "--no-trunc",
      "--filter", `label=${COMPOSE_PROJECT_LABEL}=${owner.composeProject}`,
      "--filter", `label=${COMPOSE_SERVICE_LABEL}=${hook.service}`,
    ]);
    const target = (await inspectContainers(cli, splitLines(listed.stdout), owner)).find(
      (info) =>
        info.composeProject === owner.composeProject &&
        info.composeService === hook.service &&
        info.state === "running"
    );
    if (!target) throw new Error(`il servizio "${hook.service}" dello stack non è in esecuzione`);
    container = target.name;

    log(`  comando pre-backup in ${target.name}…`);
    const result = await cli.run(["exec", target.id, "sh", "-c", hook.command], {
      timeout: hook.timeoutSec * 1000,
    });
    for (const line of splitLines(`${result.stdout}\n${result.stderr}`).slice(-20)) log(`    ${line}`);

    const ms = Date.now() - started;
    log(`  comando pre-backup completato in ${seconds(ms)}`);
    return { service: hook.service, container, ok: true, ms };
  } catch (err) {
    const error = messageOf(err);
    log(`  comando pre-backup fallito: ${error}`);
    return { service: hook.service, container, ok: false, ms: Date.now() - started, error };
  }
}

/**
 * Whether a failed pre-backup command stops the copy, and why.
 *
 * Only when nothing else would make it consistent: with the writers paused the
 * copy is still the state a power cut would have left, which is what SQLite and
 * Postgres recover from. With a live copy the command was the only guarantee,
 * and a copy that merely looks fine is the outcome this exists to prevent.
 */
export function preBackupBlocks(
  outcome: PreBackupOutcome | null,
  consistency: VolumeConsistency
): string | null {
  if (!outcome || outcome.ok || consistency === "pause") return null;
  return (
    `Il comando pre-backup è fallito (${outcome.error ?? "motivo sconosciuto"}) e il progetto chiede la ` +
    "copia a caldo: la copia sarebbe incoerente, il volume non è stato salvato"
  );
}

// --- Copying ------------------------------------------------------------------------

/**
 * Where the ids of paused containers are written down, so a panel that dies
 * mid-copy does not leave an application frozen: the next boot unpauses them.
 */
export interface PauseJournal {
  /** Before anything is paused, with everything about to be. */
  record(ids: string[]): void;
  /** Once the copy is over, with whatever could not be resumed. */
  settle(stillPaused: string[]): void;
}

export interface ExportRequest {
  volume: string;
  owner: ProjectOwner;
  image: string;
  consistency: VolumeConsistency;
  /** Where the finished `.tar.gz` is written. */
  destination: string;
  /** The uncompressed copy taken while the writers are paused; removed afterwards. */
  scratch: string;
  /** Free bytes on the disk `scratch` is on, or null when that cannot be asked. */
  freeBytes: () => number | null;
  /** Never eaten into by the uncompressed copy. */
  reserveBytes: number;
  /** A pause that lasts longer is ended, and the copy with it. */
  pauseLimitMs: number;
  journal: PauseJournal;
  log: (line: string) => void;
  signal?: AbortSignal;
}

export interface ConsistencyReport {
  /** What was asked for. */
  mode: VolumeConsistency;
  /**
   * What the copy is: `paused` — every writer was frozen; `idle` — nothing
   * was writing; `live` — something may have been writing during the copy.
   */
  result: "paused" | "idle" | "live";
  paused: string[];
  pausedMs: number | null;
  /** Writers left running, and why. */
  notPaused: { name: string; reason: string }[];
  /** `snapshot`: raw to disk while paused, compressed after; `stream`: compressed as it is read. */
  method: "snapshot" | "stream";
}

export interface ExportResult {
  bytes: number;
  rawBytes: number;
  sha256: string;
  estimatedBytes: number | null;
  consistency: ConsistencyReport;
}

/** Headroom on top of the estimate, for what is written while the copy is being planned. */
const SNAPSHOT_MARGIN = 1.1;

function tarArgs(volume: string, image: string): string[] {
  return [
    "run", "--rm",
    // Read-only, so taking a backup can never write into the volume.
    "-v", `${volume}:/from:ro`,
    "-w", "/from",
    image,
    "tar", "-cf", "-", ".",
  ];
}

/** `du -sk`, through the same helper. Null when it cannot be told. */
async function estimateBytes(cli: DockerCli, volume: string, image: string): Promise<number | null> {
  try {
    const result = await cli.run(
      ["run", "--rm", "-v", `${volume}:/from:ro`, image, "du", "-sk", "/from"],
      { timeout: 120_000 }
    );
    const kb = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

async function gzipFile(source: string, destination: string): Promise<{ bytes: number; sha256: string }> {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(
    fs.createReadStream(source),
    createGzip(),
    digest,
    fs.createWriteStream(destination, { mode: 0o600 })
  );
  return { bytes, sha256: hash.digest("hex") };
}

/**
 * A volume, copied so that the copy can be trusted.
 *
 * A tar taken while an application writes can hold a database file from one
 * instant and its write-ahead log from another: a copy that restores without
 * complaint and then fails — or worse, does not fail. So the containers of this
 * project that have the volume mounted read-write are frozen for as long as the
 * copy reads, and only them: a read-only mount cannot tear anything, and
 * another project's container is never paused on this one's behalf — it is
 * reported instead, and the copy is marked `live`.
 *
 * The pause is kept as short as the disk allows. While the writers are frozen
 * the tar goes to disk uncompressed, which is as fast as the volume can be
 * read; compressing it, which is the slow part, happens after they are running
 * again. Only when the disk has no room for that copy is it compressed while
 * they wait, and the log says so.
 */
export async function exportVolume(cli: DockerCli, request: ExportRequest): Promise<ExportResult> {
  const { volume, owner, log } = request;

  const users = await volumeUsers(cli, volume, owner);
  const writers = users.filter((user) => user.rw && ACTIVE_STATES.has(user.state));
  const notPaused: { name: string; reason: string }[] = [];

  let pausable: VolumeUser[] = [];
  if (request.consistency === "pause") {
    for (const writer of writers) {
      if (!writer.owned) notPaused.push({ name: writer.name, reason: "non è di questo progetto" });
      else if (writer.state === "restarting") notPaused.push({ name: writer.name, reason: "si sta riavviando" });
    }
    // One already paused by somebody else is not writing, and is not ours to resume.
    pausable = writers.filter((writer) => writer.owned && writer.state === "running");
  }

  const report: ConsistencyReport = {
    mode: request.consistency,
    result: "idle",
    paused: [],
    pausedMs: null,
    notPaused,
    method: "stream",
  };

  // --- nothing to pause --------------------------------------------------------------
  if (pausable.length === 0) {
    const running = writers.filter((writer) => writer.state !== "paused");
    if (request.consistency === "live" && running.length > 0) {
      report.result = "live";
      log(
        `  ATTENZIONE: copia a caldo, come chiede il progetto, con ${running.map((w) => w.name).join(", ")} ` +
          "in scrittura: la copia può essere incoerente"
      );
    } else if (notPaused.length > 0) {
      report.result = "live";
      for (const entry of notPaused) {
        log(`  ATTENZIONE: ${entry.name} scrive nel volume e ${entry.reason}: la copia può essere incoerente`);
      }
    } else {
      log("  nessun container sta scrivendo nel volume: copia senza pausa");
    }

    const result = await cli.toFile(tarArgs(volume, request.image), request.destination, {
      compress: true,
      signal: request.signal,
      onStderr: (line) => log(`  ${line}`),
    });
    return { ...result, estimatedBytes: null, consistency: report };
  }

  // --- pausing -----------------------------------------------------------------------
  const estimate = await estimateBytes(cli, volume, request.image);
  const free = request.freeBytes();
  const room = free === null ? null : free - request.reserveBytes;
  const snapshot = estimate !== null && room !== null && estimate * SNAPSHOT_MARGIN < room;
  report.method = snapshot ? "snapshot" : "stream";

  if (!snapshot) {
    log(
      estimate === null || room === null
        ? "  non riesco a stimare lo spazio per la copia rapida: comprimo durante la pausa, che durerà di più"
        : `  spazio insufficiente per la copia rapida (servono ~${megabytes(estimate)}, disponibili ` +
            `${megabytes(Math.max(room, 0))} oltre la riserva): comprimo durante la pausa, che durerà di più`
    );
  }

  // A timer of its own rather than `AbortSignal.timeout`, whose timer does not
  // hold the process open: with nothing else pending the limit would never fire.
  const limit = new AbortController();
  const limitTimer = setTimeout(() => limit.abort(), request.pauseLimitMs);
  const signal = request.signal ? AbortSignal.any([request.signal, limit.signal]) : limit.signal;

  request.journal.record(pausable.map((writer) => writer.id));
  const paused: VolumeUser[] = [];
  const started = Date.now();
  let copied: { bytes: number; rawBytes: number; sha256: string };

  try {
    for (const writer of pausable) {
      try {
        await cli.run(["pause", writer.id], { timeout: 30_000 });
        paused.push(writer);
      } catch (err) {
        notPaused.push({ name: writer.name, reason: `la pausa non è riuscita (${messageOf(err)})` });
      }
    }
    report.paused = paused.map((writer) => writer.name);
    if (paused.length > 0) log(`  in pausa: ${report.paused.join(", ")}`);
    for (const entry of notPaused) {
      log(`  ATTENZIONE: ${entry.name} scrive nel volume e ${entry.reason}: la copia può essere incoerente`);
    }

    try {
      copied = await cli.toFile(
        tarArgs(volume, request.image),
        snapshot ? request.scratch : request.destination,
        { compress: !snapshot, signal, onStderr: (line) => log(`  ${line}`) }
      );
    } catch (err) {
      if (limit.signal.aborted && !request.signal?.aborted) {
        throw new Error(
          `La copia ha superato il limite di ${Math.round(request.pauseLimitMs / 60_000)} minuti di pausa ed è ` +
            "stata interrotta; i container sono stati ripresi. Escludi le cartelle che non servono, o usa un " +
            "comando pre-backup con la copia a caldo."
        );
      }
      throw err;
    }
  } finally {
    clearTimeout(limitTimer);
    const stillPaused: string[] = [];
    for (const writer of paused) {
      try {
        await cli.run(["unpause", writer.id], { timeout: 30_000 });
      } catch (err) {
        stillPaused.push(writer.id);
        log(`  ERRORE: non riesco a riprendere ${writer.name}: ${messageOf(err)}`);
      }
    }
    request.journal.settle(stillPaused);
    report.pausedMs = Date.now() - started;
    if (paused.length > 0) {
      log(
        stillPaused.length === 0
          ? `  ripresi dopo ${seconds(report.pausedMs)} di pausa`
          : `  ${paused.length - stillPaused.length} ripresi su ${paused.length}: RunPanel riproverà al prossimo avvio`
      );
    }
  }

  report.result = notPaused.length > 0 || paused.length === 0 ? "live" : "paused";

  if (!snapshot) return { ...copied, estimatedBytes: estimate, consistency: report };

  try {
    const compressed = await gzipFile(request.scratch, request.destination);
    return { ...compressed, rawBytes: copied.rawBytes, estimatedBytes: estimate, consistency: report };
  } finally {
    fs.rmSync(request.scratch, { force: true });
  }
}

// --- Restoring ---------------------------------------------------------------------

/**
 * Make sure nothing has the volume open before it is overwritten.
 *
 * The caller has already stopped the project through its driver, and that is
 * not enough to rely on: a Compose stop is best-effort, and it needs the compose
 * file in the checkout. Whatever of this project still has the volume mounted
 * is stopped here, by id, and handed back so it can be started again. A
 * container that is not this project's is never stopped on its behalf — the
 * restore refuses instead, and writes nothing.
 */
export async function holdVolumeForRestore(
  cli: DockerCli,
  volume: string,
  owner: ProjectOwner,
  log: (line: string) => void
): Promise<string[]> {
  const active = (await volumeUsers(cli, volume, owner)).filter((user) => ACTIVE_STATES.has(user.state));

  const foreign = active.filter((user) => !user.owned);
  if (foreign.length > 0) {
    throw new Error(
      `Il volume "${volume}" è in uso da container che non sono di ${owner.slug}: ` +
        `${foreign.map((user) => user.name).join(", ")}. Fermali e ripeti il ripristino.`
    );
  }

  const stopped: string[] = [];
  for (const user of active) {
    log(`  fermo ${user.name}, che usa ancora il volume…`);
    // `stop` on a frozen container waits out its whole timeout before the kill.
    if (user.state === "paused") await cli.run(["unpause", user.id], { timeout: 30_000 }).catch(() => {});
    await cli.run(["stop", user.id], { timeout: 120_000 });
    stopped.push(user.id);
  }

  const still = (await volumeUsers(cli, volume, owner)).filter((user) => ACTIVE_STATES.has(user.state));
  if (still.length > 0) {
    throw new Error(
      `Non riesco a fermare ${still.map((user) => user.name).join(", ")}: il volume "${volume}" non è stato toccato`
    );
  }
  return stopped;
}

/** Start again what `holdVolumeForRestore` stopped. Never throws: it runs in a `finally`. */
export async function startContainers(
  cli: DockerCli,
  ids: string[],
  log: (line: string) => void
): Promise<void> {
  for (const id of ids) {
    try {
      // A no-op on a container the project's own restart already brought back.
      await cli.run(["start", id], { timeout: 120_000 });
    } catch (err) {
      log(`Non sono riuscito a riavviare il container ${id.slice(0, 12)}: ${(err as Error).message}`);
    }
  }
}

/**
 * The shell run inside the helper to replace a volume's contents.
 *
 * The glob patterns cover dotfiles too; without the second one a restore
 * leaves the previous contents' hidden files behind.
 */
export function restoreScript(): string {
  return "rm -rf /to/* /to/..?* /to/.[!.]* 2>/dev/null; tar -xf - -C /to";
}

export async function writeVolume(
  cli: DockerCli,
  request: { volume: string; image: string; archive: string; log: (line: string) => void }
): Promise<void> {
  await cli.fromFile(
    ["run", "--rm", "-i", "-v", `${request.volume}:/to`, request.image, "sh", "-c", restoreScript()],
    request.archive,
    { decompress: true, onStderr: (line) => request.log(`  ${line}`) }
  );
}
