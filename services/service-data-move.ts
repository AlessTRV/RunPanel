import { config } from "@/lib/config";
import { getDb, nowIso } from "@/lib/db";
import type { ServicesTable } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { dataPathSchema } from "@/lib/validation";
import type { AccessRow } from "@/lib/access-columns";
import { docker, dockerTry } from "./docker/cli";
import { containerMounts, isHostPath, listOwnedVolumes, removeVolumes } from "./docker/volumes";
import { serviceEvents, type MovePhase } from "./events";
import { AppendLogFile, logPathFor, readLogFile } from "./log-file";
import { databaseAdmin, execArgs, serviceTarget } from "./service-databases";
import {
  dataMountFor,
  getTemplate,
  recreateService,
  serviceRunConfig,
} from "./service-provisioner";
import path from "path";

/**
 * Moving a service's data somewhere else, without losing it.
 *
 * The whole feature is one dangerous instant — the moment the container is
 * recreated on a directory that may or may not hold the database — and every
 * decision here exists to make that instant survivable:
 *
 *  - **The old data is never touched.** The copy is one-directional and its
 *    source is mounted `:ro`. Deleting the old location is a separate, later
 *    confirmation the operator makes after checking the new one.
 *  - **"The container is running" is not success.** `postgresVolumePath`'s
 *    comment describes exactly the failure this feature can cause: a database
 *    that initialises happily on an empty directory, works perfectly, and comes
 *    back empty. So the move records what was there before and refuses to call
 *    itself done until it can see it again.
 *  - **A failure rolls back by itself.** The old location is intact by
 *    construction, so putting the container back on it is always safe, and a
 *    database that is up with an explanation beats a database that is down.
 *  - **Nothing touches the host filesystem with `fs`.** The panel may be
 *    containerised, and even when it is not, `fs` answers for the panel's mount
 *    namespace while `docker run -v` resolves against the daemon's. Only one of
 *    those is where the service container will look. Every read and every byte
 *    goes through a throwaway container, the way the Redis restore already
 *    does — and with the service's own image, which is guaranteed to be on the
 *    host, so an air-gapped install does not fail on a pull.
 */

export interface DataMoveJournal {
  id: string;
  phase: MovePhase;
  /** Where the data was. `null` means the named volume the template derives. */
  from: string | null;
  /** Where it is going. `null` means back to the default named volume. */
  to: string | null;
  /** True when the destination already held data and the copy was skipped. */
  adopted: boolean;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  rolledBack?: boolean;
  /** What may be deleted, once the operator has verified the new location. */
  leftBehind?: { kind: "volume" | "path"; ref: string };
}

/** Thrown for the states the route answers with a 409 and a machine-readable code. */
export class DataMoveRefused extends Error {
  constructor(
    readonly code:
      | "destination-not-empty"
      | "move-in-progress"
      | "same-location"
      | "insufficient-space"
      | "no-container",
    message: string,
    readonly entries?: string[]
  ) {
    super(message);
    this.name = "DataMoveRefused";
  }
}

const COPY_CONTAINER = (serviceId: string) => `runpanel-datamove-${serviceId}`;
const PROGRESS_INTERVAL_MS = 3_000;
const READY_TIMEOUT_MS = 90_000;
/** A destination this full is a destination the copy will not fit into. */
const FREE_SPACE_MARGIN = 1.05;

export function parseMoveJournal(raw: string | null): DataMoveJournal | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DataMoveJournal;
  } catch {
    return null;
  }
}

const TERMINAL: MovePhase[] = ["done", "failed"];
export const isMoveInFlight = (journal: DataMoveJournal | null): boolean =>
  Boolean(journal && !TERMINAL.includes(journal.phase));

/**
 * The rule in `dataPathSchema`, plus the one entry it cannot know about.
 *
 * `config.dataDir` is server-only and `lib/validation.ts` is bundled for the
 * browser, so it is added here — and it is the entry that matters most.
 * `<dataDir>/.secret` is the key that decrypts every credential the panel
 * holds; binding it into a database container would be a real escalation
 * rather than a mistake with a bad outcome.
 */
export function assertMountable(candidate: string): void {
  const parsed = dataPathSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Percorso non valido");

  const target = parsed.data;
  const own = config.dataDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (own && (target === own || target.startsWith(`${own}/`))) {
    throw new Error(
      "È la cartella dati del pannello: contiene la chiave che decifra ogni credenziale salvata."
    );
  }
}

// --- talking to the host through a throwaway container -----------------------

function imageFor(service: ServicesTable, projectSlug?: string): string {
  const template = getTemplate(service.type);
  const image = template?.getDockerConfig(serviceRunConfig(service, projectSlug)).image;
  if (!image) throw new Error(`Motore "${service.type}" sconosciuto`);
  return image;
}

/** `docker run --rm` with a shell, one fixed command, and no interpolation. */
async function probe(image: string, mounts: string[], script: string): Promise<string | null> {
  const result = await dockerTry(
    ["run", "--rm", "--entrypoint", "sh", ...mounts, image, "-c", script],
    { timeout: 120_000 }
  );
  return result ? result.stdout.trim() : null;
}

/**
 * What is already at the destination.
 *
 * `-v` creates the directory when it is missing, so this doubles as "does it
 * exist". `lost+found` does not count: a freshly formatted ext4 mount point has
 * one and would otherwise be permanently refused.
 */
async function destinationEntries(image: string, destination: string): Promise<string[]> {
  const out = await probe(image, ["-v", `${destination}:/dst`], "ls -A /dst 2>/dev/null | head -n 20");
  if (out === null) throw new Error(`Non riesco a leggere ${destination}`);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "lost+found");
}

/** Size in KiB. `du -sk` rather than `du -sb`, which is GNU-only. */
async function sizeKb(image: string, mount: string): Promise<number | null> {
  const out = await probe(image, ["-v", `${mount}:/from:ro`], "du -sk /from | cut -f1");
  const value = Number.parseInt((out ?? "").split(/\s+/)[0] ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

/** Free KiB at the destination, from `df -Pk`. */
async function freeKb(image: string, destination: string): Promise<number | null> {
  const out = await probe(image, ["-v", `${destination}:/dst`], "df -Pk /dst | tail -n1");
  const value = Number.parseInt((out ?? "").split(/\s+/)[3] ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

// --- what was there before, and whether it still is --------------------------

interface Inventory {
  databases?: string[];
  keys?: number;
}

/**
 * Enough of the contents to notice that they are gone.
 *
 * Not a checksum — the point is not to prove the data is byte-identical, it is
 * to refuse the one failure this feature can cause silently: a database that
 * came up on an empty directory.
 */
async function captureInventory(service: ServicesTable): Promise<Inventory> {
  const target = serviceTarget(service);

  if (service.type === "redis") {
    const result = await dockerTry(
      [
        ...execArgs(target, target.credentials.password ? { REDISCLI_AUTH: target.credentials.password } : {}),
        "redis-cli", "--no-auth-warning", "DBSIZE",
      ],
      { timeout: 15_000 }
    );
    // It throws rather than answering `{}`. An engine that cannot be asked has
    // not answered "empty" — and a container crash-looping on a data directory
    // it cannot read is exactly the case this function exists to catch, so
    // swallowing the failure here would report the move a success in the one
    // situation it must not.
    if (!result) throw new Error("Redis non risponde");
    const keys = Number.parseInt(result.stdout.replace(/\D/g, ""), 10);
    if (!Number.isFinite(keys)) throw new Error("Redis non ha risposto a DBSIZE");
    return { keys };
  }

  const admin = databaseAdmin(service.type);
  if (!admin.supported) return {};
  return { databases: await admin.list(target) };
}

/**
 * A one-line reason the new location is not the old one, or null.
 *
 * A measurement that is missing counts as a regression, never as a pass. It is
 * the same rule the status sweep follows: not being able to see something is
 * not the same as seeing that it is fine.
 */
function inventoryRegressed(before: Inventory, after: Inventory): string | null {
  if (before.databases) {
    if (!after.databases) return "il motore non ha detto quali database ha";
    const missing = before.databases.filter((name) => !after.databases!.includes(name));
    if (missing.length > 0) return `mancano ${missing.length} database: ${missing.join(", ")}`;
  }
  if (typeof before.keys === "number") {
    if (typeof after.keys !== "number") return "il motore non ha detto quante chiavi ha";
    if (after.keys < before.keys) {
      return `c'erano ${before.keys} chiavi, adesso ne risultano ${after.keys}`;
    }
  }
  return null;
}

/** Retried, because "the container started" and "the engine answers" are not the same moment. */
async function waitForInventory(service: ServicesTable): Promise<Inventory> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last: unknown;
  for (;;) {
    try {
      return await captureInventory(service);
    } catch (err) {
      last = err;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw last instanceof Error ? last : new Error("Il motore non ha risposto dopo lo spostamento");
}

// --- the journal -------------------------------------------------------------

async function writeJournal(serviceId: string, journal: DataMoveJournal): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("services")
    .set({ data_move: JSON.stringify(journal), updated_at: nowIso() })
    .where("id", "=", serviceId)
    .execute();
}

export function moveLogPath(serviceId: string): string {
  return logPathFor(path.join(config.logsDir, "service-moves"), serviceId);
}

export function moveLog(serviceId: string, tailLines = 500): string {
  return readLogFile(moveLogPath(serviceId), tailLines);
}

// --- the move ----------------------------------------------------------------

const inFlight = new Set<string>();

export interface MoveRequest {
  /** `null` goes back to the named volume the template derives. */
  path: string | null;
  adoptExisting?: boolean;
}

/**
 * Validate, then run the move in the background and answer with its id.
 *
 * Everything that can refuse does so *before* anything is touched, so a refusal
 * leaves no journal and no stopped container.
 */
export async function startDataMove(
  service: ServicesTable,
  projectSlug: string | undefined,
  request: MoveRequest
): Promise<DataMoveJournal> {
  if (inFlight.has(service.id) || isMoveInFlight(parseMoveJournal(service.data_move))) {
    throw new DataMoveRefused("move-in-progress", "Uno spostamento è già in corso.");
  }

  if (request.path !== null) assertMountable(request.path);

  const image = imageFor(service, projectSlug);
  const current = dataMountFor(serviceRunConfig(service, projectSlug));
  const next = dataMountFor(serviceRunConfig(service, projectSlug, { dataPath: request.path }));

  if (current.source === next.source) {
    throw new DataMoveRefused("same-location", "I dati sono già lì.");
  }

  let adopted = Boolean(request.adoptExisting);

  // Only a host destination can be inspected before the fact; a named volume
  // that does not exist yet is empty by definition.
  if (isHostPath(next.source)) {
    const entries = await destinationEntries(image, next.source);
    if (entries.length > 0 && !adopted) {
      throw new DataMoveRefused(
        "destination-not-empty",
        `${next.source} non è vuota: contiene ${entries.slice(0, 5).join(", ")}${entries.length > 5 ? "…" : ""}.`,
        entries
      );
    }
  } else if (adopted) {
    // Nothing to adopt in a volume the panel is about to create.
    adopted = false;
  }

  if (!adopted) {
    const [needed, available] = await Promise.all([
      sizeKb(image, current.source),
      isHostPath(next.source) ? freeKb(image, next.source) : Promise.resolve(null),
    ]);
    if (needed !== null && available !== null && available < needed * FREE_SPACE_MARGIN) {
      throw new DataMoveRefused(
        "insufficient-space",
        `Servono circa ${Math.round((needed * FREE_SPACE_MARGIN) / 1024)} MB, ne restano ${Math.round(available / 1024)}.`
      );
    }
  }

  const journal: DataMoveJournal = {
    id: generateId(),
    phase: "checking",
    from: service.data_path,
    to: request.path,
    adopted,
    startedAt: nowIso(),
  };

  // Written before anything is touched: it is what lets a panel that dies
  // halfway recognise, on the way back up, that it was in the middle of this.
  await writeJournal(service.id, journal);
  inFlight.add(service.id);

  void runMove(service, projectSlug, journal, current, next, image).finally(() => {
    inFlight.delete(service.id);
  });

  return journal;
}

async function runMove(
  service: ServicesTable,
  projectSlug: string | undefined,
  journal: DataMoveJournal,
  current: { source: string; target: string },
  next: { source: string; target: string },
  image: string
): Promise<void> {
  const file = new AppendLogFile(moveLogPath(service.id));
  const emit = (line: string) => {
    file.append(`${nowIso()} ${line}`);
    serviceEvents.emit(service.id, { type: "data:log", line });
  };

  const phase = async (value: MovePhase, error?: string) => {
    journal.phase = value;
    if (error) journal.error = error;
    if (value === "done" || value === "failed") journal.finishedAt = nowIso();
    await writeJournal(service.id, journal);
    serviceEvents.emit(service.id, { type: "data:phase", phase: value, error });
  };

  const access = currentAccess(service);

  try {
    emit(`Sposto i dati da ${current.source} a ${next.source}`);

    // The baseline. Without one there is nothing to compare against afterwards,
    // so a service that was already unreachable is moved without that check —
    // said out loud, because it is the check the rest of this depends on.
    const before = await captureInventory(service).catch((err) => {
      emit(`Non riesco a leggere il contenuto attuale (${err instanceof Error ? err.message : err}): non potrò confrontarlo dopo.`);
      return {} as Inventory;
    });
    if (before.databases) emit(`Database presenti: ${before.databases.join(", ") || "nessuno"}`);
    if (typeof before.keys === "number") emit(`Chiavi presenti: ${before.keys}`);

    await phase("stopping");
    emit("Fermo il servizio…");
    await docker(["stop", service.container_name], { timeout: 120_000 });

    if (journal.adopted) {
      emit("Uso i dati già presenti nella destinazione: nessuna copia.");
    } else {
      await phase("copying");
      await copyData(service, image, current.source, next.source, emit);
    }

    await phase("recreating");
    emit("Ricreo il container sulla nuova posizione…");
    await recreateService(service, projectSlug, access, { dataPath: journal.to });

    await phase("starting");
    emit("Attendo che il motore risponda…");
    const after = await waitForInventory({ ...service, data_path: journal.to });

    const regression = inventoryRegressed(before, after);
    if (regression) throw new Error(`I dati non sono arrivati: ${regression}`);

    const db = await getDb();
    await db
      .updateTable("services")
      .set({ data_path: journal.to, updated_at: nowIso() })
      .where("id", "=", service.id)
      .execute();

    journal.leftBehind = {
      kind: isHostPath(current.source) ? "path" : "volume",
      ref: current.source,
    };
    emit(`Fatto. I dati precedenti restano in ${current.source}.`);
    await phase("done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(`Errore: ${message}`);

    // The old location was never written to — the copy's source is mounted
    // read-only — so putting the container back on it is safe by construction.
    await phase("rolling-back");
    emit("Torno alla posizione precedente…");
    try {
      await recreateService(service, projectSlug, access, { dataPath: journal.from });
      journal.rolledBack = true;
      emit("Il servizio è di nuovo sulla posizione precedente.");
    } catch (rollbackErr) {
      journal.rolledBack = false;
      const detail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      emit(`Anche il ritorno indietro è fallito: ${detail}`);
    }

    journal.leftBehind = isHostPath(next.source)
      ? { kind: "path", ref: next.source }
      : { kind: "volume", ref: next.source };
    await phase("failed", message);
  } finally {
    file.flush();
    await dockerTry(["rm", "-f", COPY_CONTAINER(service.id)], { timeout: 30_000 });
  }
}

/**
 * `cp -a`, in a container that has both locations mounted.
 *
 * `/from/.` and not `/from/*`: the glob misses dotfiles. `-a` is what preserves
 * ownership and mode, and that is not cosmetic — Postgres refuses to start
 * unless its data directory belongs to its own uid and is 0700, so a copy that
 * lost them would produce a service that comes up, fails, and rolls back for a
 * reason nobody would guess from the message.
 *
 * Progress is polled rather than printed: `cp -av` on a Postgres data directory
 * is tens of thousands of lines through an SSE stream, where a size every three
 * seconds says the same thing in one.
 */
async function copyData(
  service: ServicesTable,
  image: string,
  from: string,
  to: string,
  emit: (line: string) => void
): Promise<void> {
  const name = COPY_CONTAINER(service.id);
  const totalKb = await sizeKb(image, from);
  emit(totalKb ? `Da copiare: ${Math.round(totalKb / 1024)} MB` : "Copia in corso…");

  await dockerTry(["rm", "-f", name], { timeout: 30_000 });
  await docker(
    [
      "run", "-d", "--name", name, "--entrypoint", "sh",
      "-v", `${from}:/from:ro`,
      "-v", `${to}:/to`,
      image,
      "-c", "set -e; cp -a /from/. /to/; sync",
    ],
    { timeout: 60_000 }
  );

  const progress = setInterval(() => {
    void (async () => {
      const result = await dockerTry(["exec", name, "du", "-sk", "/to"], { timeout: 20_000 });
      const copiedKb = Number.parseInt((result?.stdout ?? "").split(/\s+/)[0] ?? "", 10);
      if (!Number.isFinite(copiedKb)) return;
      serviceEvents.emit(service.id, { type: "data:progress", copiedKb, totalKb });
      emit(
        totalKb
          ? `  ${Math.round(copiedKb / 1024)} MB di ${Math.round(totalKb / 1024)} MB`
          : `  ${Math.round(copiedKb / 1024)} MB`
      );
    })();
  }, PROGRESS_INTERVAL_MS);
  progress.unref?.();

  try {
    const waited = await docker(["wait", name], { timeout: 24 * 60 * 60_000 });
    const code = Number.parseInt(waited.stdout.trim(), 10);
    if (code !== 0) {
      const logs = await dockerTry(["logs", "--tail", "20", name], { timeout: 20_000 });
      throw new Error(`La copia è fallita (codice ${code}): ${logs?.stderr || logs?.stdout || ""}`.trim());
    }
  } finally {
    clearInterval(progress);
  }

  emit("Copia completata.");
}

/**
 * The publish spec the container has now, carried through unchanged.
 *
 * A move must not quietly re-open a restricted service, and `provisionService`
 * fixes `-p` at creation — so the three columns travel with it.
 */
function currentAccess(service: ServicesTable): AccessRow {
  return {
    access_mode: service.access_mode,
    access_allow: service.access_allow,
    access_port: service.access_port,
  };
}

// --- afterwards --------------------------------------------------------------

/**
 * Delete what the move left behind, once the operator says the new location is
 * good.
 *
 * Asymmetric on purpose. A named volume is the panel's: it created it, labelled
 * it, and `removeVolumes` is intersected with what it actually owns. A host
 * directory is not, and RunPanel does not `rm -rf` a path an operator typed —
 * a symlink, a mount point or a typo has no upper bound. For that case it hands
 * back the command instead.
 */
export async function deletePreviousData(
  service: ServicesTable
): Promise<{ removed?: string; command?: string }> {
  const journal = parseMoveJournal(service.data_move);
  if (!journal || journal.phase !== "done" || !journal.leftBehind) {
    throw new DataMoveRefused("no-container", "Non c'è niente da eliminare.");
  }

  const { kind, ref } = journal.leftBehind;

  if (kind === "path") {
    return { command: `sudo rm -rf ${ref}` };
  }

  const owned = new Set((await listOwnedVolumes()).map((volume) => volume.name));
  if (!owned.has(ref)) throw new DataMoveRefused("no-container", `Il volume ${ref} non esiste più.`);

  const [removed] = await removeVolumes([ref]);
  if (!removed) throw new Error(`Non sono riuscito a eliminare il volume ${ref}.`);

  delete journal.leftBehind;
  await writeJournal(service.id, journal);
  return { removed };
}

// --- coming back up ----------------------------------------------------------

/**
 * A move that was in flight when the panel stopped.
 *
 * It is never *resumed*, only explained. A half-finished `cp -a` cannot be told
 * from a finished one without checksumming the whole directory, and carrying on
 * into a partly-populated destination is how a database ends up starting and
 * being subtly wrong. So the pass asks Docker where the container really is —
 * the column is a declaration, Docker is the authority — writes that down, and
 * leaves the decision to the operator.
 */
export async function reconcileDataMoves(): Promise<number> {
  const db = await getDb();
  const rows = await db
    .selectFrom("services")
    .selectAll()
    .where("data_move", "is not", null)
    .execute();

  let repaired = 0;

  for (const service of rows) {
    const journal = parseMoveJournal(service.data_move);
    if (!isMoveInFlight(journal) || !journal) continue;

    await dockerTry(["rm", "-f", COPY_CONTAINER(service.id)], { timeout: 30_000 });

    const mounts = await containerMounts(service.container_name);
    const dataTarget = dataMountFor(serviceRunConfig(service)).target;
    const mounted = mounts.find((mount) => mount.destination === dataTarget);
    const where = mounted?.name || mounted?.source || null;

    const destination = dataMountFor(serviceRunConfig(service, undefined, { dataPath: journal.to })).source;

    journal.phase = "failed";
    journal.finishedAt = nowIso();
    journal.error = "Il pannello si è riavviato durante lo spostamento.";

    if (where && where === destination) {
      // The container is on the new location, but nothing ever verified it —
      // so it is reported, not accepted.
      await db
        .updateTable("services")
        .set({ data_path: journal.to, updated_at: nowIso() })
        .where("id", "=", service.id)
        .execute();
    } else {
      journal.rolledBack = true;
    }

    await writeJournal(service.id, journal);
    repaired++;
  }

  if (repaired > 0) {
    console.log(`[data-move] ${repaired} interrupted move(s) marked for review`);
  }
  return repaired;
}
