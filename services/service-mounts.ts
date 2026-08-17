import path from "path";
import { config } from "@/lib/config";
import { getDb, nowIso } from "@/lib/db";
import type { ServicesTable } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { hostPathSchema } from "@/lib/validation";
import { postgresVolumePath } from "@/lib/service-versions";
import type { AccessRow } from "@/lib/access-columns";
import { docker, dockerTry } from "./docker/cli";
import { containerMounts } from "./docker/volumes";
import {
  copyBetweenMounts,
  copyOutOfContainer,
  destinationEntries,
  freeKb,
  sizeKb,
} from "./mount-seed";
import { serviceEvents, type MountPhase } from "./events";
import { AppendLogFile, logPathFor, readLogFile } from "./log-file";
import { databaseAdmin, execArgs, serviceTarget } from "./service-databases";
import { getTemplate, recreateService, serviceRunConfig } from "./service-provisioner";

/**
 * The folders of a service, published where the operator wants to find them.
 *
 * A bind mount is not a synchronisation — it is a **substitution**. Docker
 * copies nothing and merges nothing: it takes the host directory and makes it
 * *be* that path inside the container. Whatever was there is not deleted, it is
 * covered.
 *
 * That single fact is the whole design. Once a bind exists it is live in both
 * directions, sub-folders included, with nothing to keep in step, because it is
 * the same directory. But at the instant it is created, a host directory that is
 * empty shows the container an empty directory — the files that were there
 * vanish from view. A *managed volume* mounted empty over a path with content is
 * filled by Docker on first use, which is why the databases work out of the box;
 * a bind never is.
 *
 * So this module seeds: one pass, at creation, that fills the empty host
 * directory with what is in the container now. It is not a mechanism that runs —
 * afterwards there is nothing left to do.
 *
 * Seeding happens at two speeds, and the difference is not cosmetic. An
 * ordinary folder is a copy. The engine's **data directory** is the case where
 * `cp` without `-a` loses the uid and the 0700 that Postgres refuses to start
 * without, and where a directory seeded wrong comes back empty and reports
 * success — so that one stops the service, copies with ownership intact,
 * recreates, asks the engine whether the databases are still there, and puts
 * everything back by itself if they are not.
 */

export interface ServiceMount {
  /** Stable across edits, so a re-ordered list does not read as a new one. */
  id: string;
  /** The directory on the host. */
  source: string;
  /** Where it appears inside the container. */
  target: string;
  enabled: boolean;
  readOnly: boolean;
}

export interface MountJournal {
  id: string;
  phase: MountPhase;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  rolledBack?: boolean;
  /** The mount being seeded, when one is. */
  seeding?: { id: string; source: string; target: string; careful: boolean };
}

/** The refusals the route answers with a 409 and a machine-readable code. */
export class MountRefused extends Error {
  constructor(
    readonly code:
      | "destination-not-empty"
      | "apply-in-progress"
      | "insufficient-space"
      | "data-mount-removed"
      /** Project-side, where a bind is a container concept and a build is needed. */
      | "runtime-not-docker"
      | "no-image",
    message: string,
    readonly mountId?: string,
    readonly entries?: string[]
  ) {
    super(message);
    this.name = "MountRefused";
  }
}

const SEED_CONTAINER = (serviceId: string) => `runpanel-mountseed-${serviceId}`;
const READY_TIMEOUT_MS = 90_000;
/** A destination this full is one the copy will not fit into. */
const FREE_SPACE_MARGIN = 1.05;

export function parseMounts(raw: string | null): ServiceMount[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ServiceMount[]) : [];
  } catch {
    return [];
  }
}

export function newMountId(): string {
  return generateId();
}

export function parseApplyJournal(raw: string | null): MountJournal | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MountJournal;
  } catch {
    return null;
  }
}

const TERMINAL: MountPhase[] = ["done", "failed"];
export const isApplyInFlight = (journal: MountJournal | null): boolean =>
  Boolean(journal && !TERMINAL.includes(journal.phase));

/**
 * What the container is really mounted with, as Docker reports it.
 *
 * The column says what the panel intended; this says what happened. They differ
 * exactly when something went wrong, which is when the operator most needs the
 * page to be honest.
 *
 * Cached, because the service page polls every five seconds and this is a
 * `docker inspect`. It changes only when the container is recreated.
 */
const mountsCache = new Map<string, { at: number; value: { source: string; target: string }[] }>();
const MOUNTS_TTL_MS = 30_000;

export async function currentMounts(
  container: string
): Promise<{ source: string; target: string }[]> {
  const cached = mountsCache.get(container);
  if (cached && Date.now() - cached.at < MOUNTS_TTL_MS) return cached.value;

  const value = (await containerMounts(container)).map((mount) => ({
    source: mount.name || mount.source,
    target: mount.destination,
  }));
  mountsCache.set(container, { at: Date.now(), value });
  return value;
}

/**
 * Drop the cached answer for a container that has just been recreated.
 *
 * Without this the page keeps reporting the *previous* mounts for up to the TTL
 * — which is precisely the half-minute after an apply, when somebody is
 * watching to see whether it worked. A cache that is stale exactly when it is
 * read is worse than no cache.
 */
export function invalidateMounts(container: string): void {
  mountsCache.delete(container);
}

/**
 * The rule in `hostPathSchema`, plus the one entry it cannot know about.
 *
 * `config.dataDir` is server-only and `lib/validation.ts` is bundled for the
 * browser, so it is added here — and it is the entry that matters most.
 * `<dataDir>/.secret` is the key that decrypts every credential the panel
 * holds; binding it into a container would be an escalation, not a typo.
 */
export function assertMountable(candidate: string): void {
  const parsed = hostPathSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Percorso non valido");

  const target = parsed.data;
  const own = config.dataDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (own && (target === own || target.startsWith(`${own}/`))) {
    throw new Error(
      "È la cartella dati del pannello: contiene la chiave che decifra ogni credenziale salvata."
    );
  }
}

/**
 * Whether a container path is where the engine keeps its database.
 *
 * The comparison is against the mount the template declares rather than a table
 * of strings, so PostgreSQL 18 — which moved its data directory, see
 * `postgresVolumePath` — cannot fall out of step with it.
 */
export function isEngineDataPath(service: ServicesTable, target: string): boolean {
  const template = getTemplate(service.type);
  const declared = template?.getDockerConfig(serviceRunConfig(service)).volumes[0];
  if (!declared) return false;

  const separator = declared.indexOf(":");
  const declaredTarget = separator === -1 ? "" : declared.slice(separator + 1);
  const normalise = (value: string) => value.replace(/\/+$/, "");

  // Belt and braces for Postgres, whose declared path depends on the major.
  return (
    normalise(declaredTarget) === normalise(target) ||
    (service.type === "postgresql" &&
      normalise(postgresVolumePath(service.version)) === normalise(target))
  );
}

// --- talking to the host through a throwaway container -----------------------

function imageFor(service: ServicesTable, projectSlug?: string): string {
  const template = getTemplate(service.type);
  const image = template?.getDockerConfig(serviceRunConfig(service, projectSlug)).image;
  if (!image) throw new Error(`Motore "${service.type}" sconosciuto`);
  return image;
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
 * to refuse the one failure this can cause silently: a database that came up on
 * an empty directory.
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
    // it cannot read is exactly the case this exists to catch, so swallowing the
    // failure here would report success in the one situation it must not.
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
 * A measurement that is missing counts as a regression, never as a pass — the
 * same rule the status sweep follows: not being able to see something is not
 * the same as seeing that it is fine.
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

/** Retried: "the container started" and "the engine answers" are not one moment. */
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
  throw last instanceof Error ? last : new Error("Il motore non ha risposto");
}

// --- the journal -------------------------------------------------------------

async function writeJournal(serviceId: string, journal: MountJournal | null): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("services")
    .set({ mount_apply: journal ? JSON.stringify(journal) : null, updated_at: nowIso() })
    .where("id", "=", serviceId)
    .execute();
}

export function applyLogPath(serviceId: string): string {
  return logPathFor(path.join(config.logsDir, "service-mounts"), serviceId);
}

export function applyLog(serviceId: string, tailLines = 500): string {
  return readLogFile(applyLogPath(serviceId), tailLines);
}

/**
 * The publish spec the container has now, carried through unchanged.
 *
 * Recreating must not quietly re-open a restricted service, and
 * `provisionService` fixes `-p` at creation — so the three columns travel with
 * it.
 */
function currentAccess(service: ServicesTable): AccessRow {
  return {
    access_mode: service.access_mode,
    access_allow: service.access_allow,
    access_port: service.access_port,
  };
}

// --- applying ----------------------------------------------------------------

const inFlight = new Set<string>();

export interface ApplyOptions {
  /** Ids whose destination is already non-empty and which are adopted as they are. */
  adopt?: string[];
  /**
   * Ids of data-directory binds the operator has agreed to give up.
   *
   * Switching one off puts the engine back on the volume it had before, which
   * still holds whatever was there then — so the database silently becomes an
   * older one. Refusing until it is said out loud is the whole point of the
   * field; it is not a formality.
   */
  releaseData?: string[];
}

/**
 * Validate the whole list, then apply it in the background.
 *
 * Everything that can refuse does so **before** anything is touched, so a
 * refusal leaves the service exactly as it was.
 */
export async function applyMounts(
  service: ServicesTable,
  projectSlug: string | undefined,
  next: ServiceMount[],
  opts: ApplyOptions = {}
): Promise<MountJournal> {
  if (inFlight.has(service.id)) {
    throw new MountRefused("apply-in-progress", "Un'applicazione è già in corso.");
  }

  for (const mount of next) {
    assertMountable(mount.source);

    // An engine cannot write its own data directory read-only. It would start,
    // fail on the first write, and the reason would be buried in its log.
    if (mount.enabled && mount.readOnly && isEngineDataPath(service, mount.target)) {
      throw new Error(
        `${mount.target} è la cartella dati del motore: montata in sola lettura il servizio non parte.`
      );
    }
  }

  const targets = next.filter((m) => m.enabled).map((m) => m.target.replace(/\/+$/, ""));
  const duplicate = targets.find((t, i) => targets.indexOf(t) !== i);
  if (duplicate) {
    throw new Error(`Due bind puntano allo stesso percorso nel container: ${duplicate}`);
  }

  const previous = parseMounts(service.mounts);
  const adopt = new Set(opts.adopt ?? []);
  const release = new Set(opts.releaseData ?? []);
  const image = imageFor(service, projectSlug);

  /*
    Giving up a bind on the data directory is not the same kind of edit as the
    others, and it is the one that can lose data without saying so.

    The engine goes back to the volume it used before, which still holds
    whatever was in it when the bind was made. Everything written since lives on
    in the host directory, unreachable, while the service comes up on an older
    database and works perfectly. Nothing downstream would notice — the
    verification below only runs for mounts being switched *on*.
  */
  const released = previous.filter(
    (old) =>
      old.enabled &&
      isEngineDataPath(service, old.target) &&
      !next.some(
        (m) => m.enabled && m.target === old.target && m.source === old.source
      )
  );

  const unacknowledged = released.find((old) => !release.has(old.id));
  if (unacknowledged) {
    throw new MountRefused(
      "data-mount-removed",
      `${unacknowledged.source} contiene i dati di questo servizio. Togliendo il bind il motore torna sul volume di prima, che è fermo a com'era quando l'hai aggiunto: quello che hai scritto da allora resta nella cartella e il servizio riparte su dati più vecchi.`,
      unacknowledged.id
    );
  }

  // Only the ones being switched on now need seeding: an existing bind already
  // holds whatever it holds, and turning one off changes nothing on disk.
  const fresh = next.filter(
    (mount) =>
      mount.enabled &&
      !previous.some((old) => old.enabled && old.source === mount.source && old.target === mount.target)
  );

  const toSeed: { mount: ServiceMount; from: string | null; careful: boolean }[] = [];

  for (const mount of fresh) {
    const entries = await destinationEntries(image, mount.source);
    if (entries.length > 0) {
      if (!adopt.has(mount.id)) {
        throw new MountRefused(
          "destination-not-empty",
          `${mount.source} non è vuota: contiene ${entries.slice(0, 5).join(", ")}${entries.length > 5 ? "…" : ""}.`,
          mount.id,
          entries
        );
      }
      // Adopted: the operator says those bytes are the data. Nothing to copy.
      continue;
    }

    // Where the content is now: a mount already covering this target, or the
    // container's own filesystem.
    const mounted = (await containerMounts(service.container_name)).find(
      (m) => m.destination.replace(/\/+$/, "") === mount.target.replace(/\/+$/, "")
    );
    const from = mounted ? mounted.name || mounted.source : null;

    if (from) {
      const [needed, available] = await Promise.all([
        sizeKb(image, from),
        freeKb(image, mount.source),
      ]);
      if (needed !== null && available !== null && available < needed * FREE_SPACE_MARGIN) {
        throw new MountRefused(
          "insufficient-space",
          `Servono circa ${Math.round((needed * FREE_SPACE_MARGIN) / 1024)} MB in ${mount.source}, ne restano ${Math.round(available / 1024)}.`,
          mount.id
        );
      }
    }

    toSeed.push({ mount, from, careful: isEngineDataPath(service, mount.target) });
  }

  const journal: MountJournal = {
    id: generateId(),
    phase: "checking",
    startedAt: nowIso(),
  };

  await writeJournal(service.id, journal);
  inFlight.add(service.id);

  void runApply(service, projectSlug, journal, previous, next, toSeed, image).finally(() => {
    inFlight.delete(service.id);
  });

  return journal;
}

async function runApply(
  service: ServicesTable,
  projectSlug: string | undefined,
  journal: MountJournal,
  previous: ServiceMount[],
  next: ServiceMount[],
  toSeed: { mount: ServiceMount; from: string | null; careful: boolean }[],
  image: string
): Promise<void> {
  const file = new AppendLogFile(applyLogPath(service.id));
  const emit = (line: string) => {
    file.append(`${nowIso()} ${line}`);
    serviceEvents.emit(service.id, { type: "mount:log", line });
  };

  const report = {
    emit,
    progress: (copiedKb: number, totalKb: number | null) =>
      serviceEvents.emit(service.id, { type: "mount:progress", copiedKb, totalKb }),
  };

  const phase = async (value: MountPhase, error?: string) => {
    journal.phase = value;
    if (error) journal.error = error;
    if (value === "done" || value === "failed") journal.finishedAt = nowIso();
    await writeJournal(service.id, journal);
    serviceEvents.emit(service.id, { type: "mount:phase", phase: value, error });
  };

  const access = currentAccess(service);
  const careful = toSeed.some((entry) => entry.careful);
  const db = await getDb();

  try {
    // A careful seed touches the database, so its contents are recorded first —
    // "the container started" says nothing about whether the data came with it.
    let before: Inventory = {};
    if (careful) {
      before = await captureInventory(service).catch((err) => {
        emit(`Non riesco a leggere il contenuto attuale (${err instanceof Error ? err.message : err}).`);
        return {} as Inventory;
      });
      if (before.databases) emit(`Database presenti: ${before.databases.join(", ") || "nessuno"}`);
      if (typeof before.keys === "number") emit(`Chiavi presenti: ${before.keys}`);
    }

    if (toSeed.length > 0) {
      await phase("stopping");
      emit("Fermo il servizio…");
      await docker(["stop", service.container_name], { timeout: 120_000 });

      await phase("seeding");
      for (const entry of toSeed) {
        journal.seeding = {
          id: entry.mount.id,
          source: entry.mount.source,
          target: entry.mount.target,
          careful: entry.careful,
        };
        await writeJournal(service.id, journal);

        emit(`Semino ${entry.mount.source} da ${entry.mount.target}…`);
        if (entry.from) {
          await copyBetweenMounts({
            container: SEED_CONTAINER(service.id),
            image,
            from: entry.from,
            to: entry.mount.source,
            report,
          });
        } else {
          await copyOutOfContainer({
            sourceContainer: service.container_name,
            image,
            target: entry.mount.target,
            to: entry.mount.source,
            report,
          });
        }
      }
      journal.seeding = undefined;
    }

    await phase("recreating");
    emit("Ricreo il container…");
    await recreateService({ ...service, mounts: JSON.stringify(next) }, projectSlug, access);
    invalidateMounts(service.container_name);

    if (careful) {
      await phase("verifying");
      emit("Aspetto che il motore risponda…");
      const after = await waitForInventory({ ...service, mounts: JSON.stringify(next) });
      const regression = inventoryRegressed(before, after);
      if (regression) throw new Error(`I dati non sono arrivati: ${regression}`);
    }

    // Written last, deliberately. Until this line the row describes the
    // container that actually exists, so a panel that dies anywhere above comes
    // back knowing what to put back rather than what was hoped for.
    await db
      .updateTable("services")
      .set({ mounts: JSON.stringify(next), updated_at: nowIso() })
      .where("id", "=", service.id)
      .execute();

    emit("Fatto.");
    await phase("done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(`Errore: ${message}`);

    // The previous locations were never written to — every copy reads its source
    // read-only — so putting the container back on the old list is safe by
    // construction.
    await phase("rolling-back");
    emit("Torno alla configurazione precedente…");
    try {
      await recreateService({ ...service, mounts: JSON.stringify(previous) }, projectSlug, access);
      invalidateMounts(service.container_name);
      journal.rolledBack = true;
      emit("Il servizio è di nuovo com'era.");
    } catch (rollbackErr) {
      journal.rolledBack = false;
      const detail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      emit(`Anche il ritorno indietro è fallito: ${detail}`);
    }

    await phase("failed", message);
  } finally {
    file.flush();
    await dockerTry(["rm", "-f", SEED_CONTAINER(service.id)], { timeout: 30_000 });
  }
}

// --- coming back up ----------------------------------------------------------

/**
 * An application that was in flight when the panel stopped.
 *
 * Never resumed, only explained — a half-finished `cp -a` cannot be told from a
 * finished one without checksumming the tree, and carrying on into a
 * partly-populated directory is how a database ends up starting and being
 * subtly wrong.
 *
 * There is one thing it does repair, because leaving it would leave a service
 * that no operator can start: the window between `docker rm -f` and
 * `docker run`, where the container simply does not exist. The `mounts` column
 * is written only after a verified recreate, so it still describes the last
 * configuration known to work — which makes rebuilding from it safe.
 */
export async function reconcileMountApplies(): Promise<number> {
  const db = await getDb();
  const rows = await db
    .selectFrom("services")
    .selectAll()
    .where("mount_apply", "is not", null)
    .execute();

  let repaired = 0;

  for (const service of rows) {
    const journal = parseApplyJournal(service.mount_apply);
    if (!isApplyInFlight(journal) || !journal) continue;

    await dockerTry(["rm", "-f", SEED_CONTAINER(service.id)], { timeout: 30_000 });

    const exists = await dockerTry(["inspect", "-f", "{{.Id}}", service.container_name], {
      timeout: 15_000,
    });

    if (!exists) {
      const project = service.project_id
        ? await db
            .selectFrom("projects")
            .select("slug")
            .where("id", "=", service.project_id)
            .executeTakeFirst()
        : undefined;
      try {
        await recreateService(service, project?.slug, currentAccess(service));
        invalidateMounts(service.container_name);
      } catch (err) {
        console.error(
          `[mounts] Could not rebuild ${service.container_name}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    journal.phase = "failed";
    journal.finishedAt = nowIso();
    journal.error = "Il pannello si è riavviato durante l'applicazione.";
    journal.rolledBack = !exists;
    await writeJournal(service.id, journal);
    repaired++;
  }

  if (repaired > 0) {
    console.log(`[mounts] ${repaired} interrupted application(s) marked for review`);
  }
  return repaired;
}
