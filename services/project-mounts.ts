import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { formatMountString, parseMountString } from "@/lib/mount";
import { parseContractJson, type DeployContract } from "@/lib/deploy-contract";
import { appContainerName } from "./docker/labels";
import { dockerTry } from "./docker/cli";
import { projectEvents, type MountPhase } from "./events";
import { AppendLogFile, logPathFor, readLogFile } from "./log-file";
import { config } from "@/lib/config";
import { copyOutOfContainer, destinationEntries, freeKb, sizeKb } from "./mount-seed";
import { restartFromLastDeployment } from "./project-restart";
import { assertMountable, MountRefused, type MountJournal } from "./service-mounts";
import path from "path";

/**
 * The same bind list, on a project that runs in a container.
 *
 * `docker.mounts` has been in the deploy contract from the beginning: panel-only
 * so a repository cannot grant itself a mount of `/` or of the Docker socket,
 * and already reaching `docker run -v`. What it never had was a way to set it —
 * only hand-writing the contract — nor any validation, nor the seeding that
 * makes a new bind show what was already there.
 *
 * The differences from the service side are three, and they are all about what a
 * project is: there is no engine, so no data directory to treat carefully and
 * nothing to verify afterwards; the content to seed from always lives in the
 * image rather than in a volume; and applying is a restart from the last
 * deployment rather than a container recreated from a template.
 */

export interface ProjectMount {
  source: string;
  target: string;
  readOnly: boolean;
  enabled: boolean;
}

/**
 * The contract's mounts as rows.
 *
 * A stored string carries no on/off switch, so anything already in a contract
 * is by definition enabled — it is being passed to `docker run` today.
 */
export function projectMounts(contract: DeployContract): ProjectMount[] {
  return contract.docker.mounts
    .map((raw) => parseMountString(raw))
    .filter((spec): spec is NonNullable<typeof spec> => spec !== null)
    .map((spec) => ({ ...spec, enabled: true }));
}

/** Back to the spelling the contract stores. Disabled rows simply do not appear. */
export function mountStrings(mounts: ProjectMount[]): string[] {
  return mounts.filter((mount) => mount.enabled).map(formatMountString);
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

export function applyLogPath(projectId: string): string {
  return logPathFor(path.join(config.logsDir, "project-mounts"), projectId);
}

export function applyLog(projectId: string, tailLines = 500): string {
  return readLogFile(applyLogPath(projectId), tailLines);
}

/**
 * The image the project's container runs.
 *
 * Taken from the last successful deployment's start command, which the Docker
 * driver stores as `docker:<ref>`. Null before the first deploy — and then there
 * is genuinely nothing to copy out of, which is worth saying rather than seeding
 * an empty folder in silence.
 */
async function deployedImage(projectId: string): Promise<string | null> {
  const db = await getDb();
  const last = await db
    .selectFrom("deployments")
    .select("start_cmd")
    .where("project_id", "=", projectId)
    .where("status", "=", "running")
    .orderBy("started_at", "desc")
    .executeTakeFirst();

  const command = last?.start_cmd ?? "";
  return command.startsWith("docker:") ? command.slice("docker:".length) : null;
}

async function writeJournal(projectId: string, journal: MountJournal): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("projects")
    .set({ mount_apply: JSON.stringify(journal), updated_at: nowIso() })
    .where("id", "=", projectId)
    .execute();
}

const inFlight = new Set<string>();

/**
 * Validate the whole list, then apply it in the background.
 *
 * Everything that can refuse does so before anything is touched, so a refusal
 * leaves the project exactly as it was.
 */
export async function applyProjectMounts(
  project: ProjectsTable,
  next: ProjectMount[],
  opts: { adopt?: string[] } = {}
): Promise<MountJournal> {
  if (project.runtime_type !== "docker") {
    throw new MountRefused(
      "runtime-not-docker",
      "I bind sono una cosa del container: questo progetto non ne ha uno."
    );
  }

  if (inFlight.has(project.id) || isApplyInFlight(parseApplyJournal(project.mount_apply))) {
    throw new MountRefused("apply-in-progress", "Un'applicazione è già in corso.");
  }

  for (const mount of next) assertMountable(mount.source);

  const targets = next.filter((m) => m.enabled).map((m) => m.target.replace(/\/+$/, ""));
  const duplicate = targets.find((t, i) => targets.indexOf(t) !== i);
  if (duplicate) {
    throw new Error(`Due bind puntano allo stesso percorso nel container: ${duplicate}`);
  }

  const contract = parseContractJson(project.builder_config);
  const previous = projectMounts(contract);
  const adopt = new Set(opts.adopt ?? []);

  const fresh = next.filter(
    (mount) =>
      mount.enabled &&
      !previous.some((old) => old.source === mount.source && old.target === mount.target)
  );

  const image = await deployedImage(project.id);
  const toSeed: ProjectMount[] = [];

  for (const mount of fresh) {
    if (!image) {
      throw new MountRefused(
        "no-image",
        "Il progetto non è mai stato distribuito, quindi non c'è niente da copiare fuori. Fai un deploy, poi aggiungi il bind."
      );
    }

    const entries = await destinationEntries(image, mount.source);
    if (entries.length > 0) {
      if (!adopt.has(mount.target)) {
        throw new MountRefused(
          "destination-not-empty",
          `${mount.source} non è vuota: contiene ${entries.slice(0, 5).join(", ")}${entries.length > 5 ? "…" : ""}.`,
          mount.target,
          entries
        );
      }
      continue;
    }
    toSeed.push(mount);
  }

  if (image && toSeed.length > 0) {
    const [needed, available] = await Promise.all([
      sizeKb(image, toSeed[0].source),
      freeKb(image, toSeed[0].source),
    ]);
    if (needed !== null && available !== null && available < needed * 1.05) {
      throw new MountRefused("insufficient-space", "Non c'è spazio a sufficienza nella destinazione.");
    }
  }

  const journal: MountJournal = { id: generateId(), phase: "checking", startedAt: nowIso() };
  await writeJournal(project.id, journal);
  inFlight.add(project.id);

  void runApply(project, contract, journal, previous, next, toSeed, image).finally(() => {
    inFlight.delete(project.id);
  });

  return journal;
}

async function runApply(
  project: ProjectsTable,
  contract: DeployContract,
  journal: MountJournal,
  previous: ProjectMount[],
  next: ProjectMount[],
  toSeed: ProjectMount[],
  image: string | null
): Promise<void> {
  const file = new AppendLogFile(applyLogPath(project.id));
  const emit = (line: string) => {
    file.append(`${nowIso()} ${line}`);
    projectEvents.emit(project.id, { type: "mount:log", line });
  };
  const report = {
    emit,
    progress: (copiedKb: number, totalKb: number | null) =>
      projectEvents.emit(project.id, { type: "mount:progress", copiedKb, totalKb }),
  };

  const phase = async (value: MountPhase, error?: string) => {
    journal.phase = value;
    if (error) journal.error = error;
    if (value === "done" || value === "failed") journal.finishedAt = nowIso();
    await writeJournal(project.id, journal);
    projectEvents.emit(project.id, { type: "mount:phase", phase: value, error });
  };

  const db = await getDb();
  const write = (mounts: ProjectMount[]) =>
    db
      .updateTable("projects")
      .set({
        builder_config: JSON.stringify({
          ...contract,
          docker: { ...contract.docker, mounts: mountStrings(mounts) },
        }),
        updated_at: nowIso(),
      })
      .where("id", "=", project.id)
      .execute();

  try {
    if (toSeed.length > 0 && image) {
      await phase("seeding");
      for (const mount of toSeed) {
        journal.seeding = { id: mount.target, source: mount.source, target: mount.target, careful: false };
        await writeJournal(project.id, journal);
        emit(`Semino ${mount.source} da ${mount.target}…`);
        await copyOutOfContainer({
          sourceContainer: appContainerName(project.slug),
          image,
          target: mount.target,
          to: mount.source,
          report,
        });
      }
      journal.seeding = undefined;
    }

    await phase("recreating");
    emit("Riavvio il container con la nuova lista…");
    // Written before the restart, because `restartFromLastDeployment` re-reads
    // the row to build the start options.
    await write(next);
    await restartFromLastDeployment(project.id);

    emit("Fatto.");
    await phase("done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(`Errore: ${message}`);

    await phase("rolling-back");
    emit("Torno alla lista precedente…");
    try {
      await write(previous);
      await restartFromLastDeployment(project.id);
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
    await dockerTry(["rm", "-f", `runpanel-mountseed-${project.id}`], { timeout: 30_000 });
  }
}
