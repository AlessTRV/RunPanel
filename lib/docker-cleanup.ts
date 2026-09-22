/**
 * The arithmetic and the argument lists behind the Storage page's clean.
 *
 * No imports, so the unit suite loads it directly. Everything that decides
 * *what* a clean removes lives here as data, and `services/docker/gc.ts` only
 * runs it — which is what lets the choice be tested without a daemon, and
 * without letting a test loose on a machine full of somebody else's images.
 */

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
};

/**
 * `966.7MB`, `12kB`, `13.33GB (37%)` — the way the Docker CLI prints a size.
 * Decimal units, like Docker's own formatter. Anything unreadable is zero, so
 * a surprising line cannot turn a total into NaN.
 */
export function parseDockerSize(text: string): number {
  const match = text.trim().match(/^([\d.]+)\s*([kKMGT]?B)/);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * (UNITS[match[2].toUpperCase()] ?? 1));
}

/**
 * What a prune says it freed.
 *
 * Two spellings. `image prune` ends with `Total reclaimed space: 1.2GB`;
 * `builder prune` under BuildKit ends with `Total:\t1.2GB`. Only the first was
 * recognised, so the build cache — usually the biggest thing a clean removes —
 * was always counted as nothing, and the page said "0 B".
 */
export function parseReclaimed(stdout: string): number {
  const match = stdout.match(/Total(?: reclaimed space)?:\s*([\d.]+\s*[kKMGT]?B)/);
  return match ? parseDockerSize(match[1]) : 0;
}

/** The sum of `docker system df --format '{{.Type}}\t{{.Size}}'`. */
export function footprintFromDf(stdout: string): number {
  let total = 0;
  for (const line of stdout.split("\n")) {
    const size = line.split("\t")[1];
    if (size) total += parseDockerSize(size);
  }
  return total;
}

/**
 * Build cache, by age. Zero means all of it — what the button asks for, since
 * the cache is pure cache: the next build of each project is slower, nothing
 * else is lost. The periodic pass keeps a week.
 */
export function buildCachePruneArgs(keepHours: number): string[] {
  return keepHours <= 0
    ? ["builder", "prune", "-f", "--all"]
    : ["builder", "prune", "-f", "--filter", `until=${keepHours}h`];
}

/**
 * Images with no tag that no container uses.
 *
 * The routine pass stays on RunPanel's own. The deep one — the button — takes
 * every one of them: an image with no name cannot be run by anybody, and the
 * ones a compose rebuild leaves behind carry compose's labels rather than
 * ours, so the routine pass never saw them.
 */
export function danglingImagePruneArgs(deep: boolean): string[] {
  const args = ["image", "prune", "-f", "--filter", "dangling=true"];
  if (!deep) args.push("--filter", "label=runpanel.managed=true");
  return args;
}

/**
 * Every image no container uses, the operator's own included — opt-in only.
 *
 * RunPanel's tagged project images are spared: they are the rollback set the
 * retention setting decides about. Everything else comes back with a pull or
 * a rebuild, except an image somebody built by hand and never pushed, which
 * is why this is never a default.
 *
 * Chosen here rather than with `image prune -a --filter label!=…`: under the
 * containerd image store that Docker Desktop and recent engines use, the
 * negated label filter combined with another selects nothing — checked
 * against Docker 29, not assumed. The caller removes each ref without `-f`,
 * so an image a container started using in the meantime is refused, not
 * deleted.
 */
export function unusedImageRefs(
  images: readonly { id: string; ref: string }[],
  ownedIds: ReadonlySet<string>,
  /** Image ids of every container, running or not; full digests are fine. */
  usedIds: ReadonlySet<string>
): string[] {
  const short = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);
  const used = new Set([...usedIds].map(short));
  const owned = new Set([...ownedIds].map(short));

  const refs: string[] = [];
  for (const image of images) {
    const id = short(image.id);
    if (used.has(id) || owned.has(id)) continue;
    refs.push(image.ref.includes("<none>") ? id : image.ref);
  }
  return [...new Set(refs)];
}

/**
 * Images compose built for a RunPanel project that no longer exists.
 *
 * Compose names the project `runpanel-<slug>` and stamps that on every image
 * it builds. A stack the operator runs by hand never has that prefix, and an
 * image compose did not build has no project label at all — neither is ever
 * a candidate.
 */
export function composeOrphanImages(
  images: readonly { ref: string; composeProject: string | null }[],
  knownSlugs: ReadonlySet<string>
): string[] {
  return images
    .filter((image) => {
      const project = image.composeProject;
      if (!project || !project.startsWith("runpanel-")) return false;
      return !knownSlugs.has(project.slice("runpanel-".length));
    })
    .map((image) => image.ref);
}

/**
 * Log rotation for every container RunPanel starts.
 *
 * Docker's default `json-file` driver keeps a container's whole output in one
 * file on the host, forever. Ten megabytes times three is enough to read back
 * a crash and small enough that a chatty app cannot fill the disk.
 */
export const CONTAINER_LOG_ARGS: readonly string[] = [
  "--log-opt",
  "max-size=10m",
  "--log-opt",
  "max-file=3",
];
