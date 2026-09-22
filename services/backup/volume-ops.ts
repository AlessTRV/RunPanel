/**
 * The Docker side of backing up and restoring a project's volumes.
 *
 * Every call goes through an injected `DockerCli`, and nothing here imports a
 * value from the rest of the panel. That is what lets the unit suite drive the
 * whole sequence against a simulated daemon — which containers get stopped,
 * in which order, and what is never touched — without a real one, and without
 * letting a test loose on a machine full of somebody else's containers.
 */

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

/** States in which a container can still touch its volumes. */
const ACTIVE_STATES = new Set(["running", "paused", "restarting"]);

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
