import { docker, dockerTry, lines } from "./cli";
import { imageRepo, labelArgs, ownedFilters } from "./labels";
import {
  buildCachePruneArgs,
  composeOrphanImages,
  danglingImagePruneArgs,
  parseReclaimed,
  unusedImageRefs,
} from "@/lib/docker-cleanup";

/**
 * Image lifecycle.
 *
 * The previous builder tagged every build of a project `runpanel-<slug>` — the
 * same tag every time. Docker responds by untagging the old image, which then
 * sits on disk forever as a dangling `<none>` layer set. Nothing in the codebase
 * ever reclaimed it, so each redeploy leaked a full image's worth of disk.
 *
 * Now each build gets an immutable tag (the deployment id) plus a moving
 * `:current` alias, so rollback is possible and cleanup is a decision rather
 * than an accident.
 */

export interface ImageInfo {
  id: string;
  repository: string;
  tag: string;
  createdAt: string;
  size: string;
}

export const CURRENT_TAG = "current";

export function imageTag(slug: string, deploymentId: string): string {
  return `${imageRepo(slug)}:${deploymentId}`;
}

export function currentImageTag(slug: string): string {
  return `${imageRepo(slug)}:${CURRENT_TAG}`;
}

export interface BuildImageOptions {
  slug: string;
  deploymentId: string;
  contextDir: string;
  dockerfile?: string;
  target?: string;
  buildArgs?: Record<string, string>;
  timeout?: number;
  onLog?: (line: string) => void;
}

/** Build args for `docker build`, kept separate so they are easy to log. */
export function buildArgsToFlags(buildArgs: Record<string, string> = {}): string[] {
  return Object.entries(buildArgs).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]);
}

const IMAGE_FORMAT = "{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}";

function parseImages(stdout: string): ImageInfo[] {
  return lines(stdout).map((line) => {
    const [id, repository, tag, createdAt, size] = line.split("\t");
    return { id, repository, tag, createdAt, size };
  });
}

/** Every image RunPanel built for a project, newest first. */
export async function listProjectImages(slug: string): Promise<ImageInfo[]> {
  const result = await dockerTry([
    "images",
    ...ownedFilters({ project: slug }),
    "--format",
    IMAGE_FORMAT,
  ]);
  return result ? parseImages(result.stdout) : [];
}

/** Every image RunPanel owns, across all projects. */
export async function listOwnedImages(): Promise<ImageInfo[]> {
  const result = await dockerTry(["images", ...ownedFilters(), "--format", IMAGE_FORMAT]);
  return result ? parseImages(result.stdout) : [];
}

export async function removeImages(refs: string[]): Promise<number> {
  let removed = 0;
  for (const ref of refs) {
    const result = await dockerTry(["rmi", "-f", ref], { timeout: 60_000 });
    if (result) removed++;
  }
  return removed;
}

/**
 * Keep the newest `keep` immutable tags for a project and drop the rest.
 * `:current` is never a deletion candidate — it is an alias for one of them.
 */
export async function pruneProjectImages(slug: string, keep: number): Promise<string[]> {
  const images = await listProjectImages(slug);

  const candidates = images.filter(
    (image) => image.repository === imageRepo(slug) && image.tag !== CURRENT_TAG && image.tag !== "<none>"
  );

  // `docker images` already lists newest first; the slice is what survives.
  const doomed = candidates.slice(Math.max(0, keep));
  const refs = doomed.map((image) => `${image.repository}:${image.tag}`);

  await removeImages(refs);
  return refs;
}

/** Remove every image belonging to a project, including `:current`. */
export async function removeProjectImages(slug: string): Promise<string[]> {
  const images = await listProjectImages(slug);
  const refs = images.map((image) =>
    image.tag === "<none>" ? image.id : `${image.repository}:${image.tag}`
  );
  await removeImages(refs);
  return refs;
}

/**
 * Images with no tag and no container. Routine: RunPanel's own only. Deep —
 * the Storage page's button — every one of them, which is where a compose
 * rebuild's leftovers are: they carry compose's labels, not ours.
 */
export async function pruneDangling(deep = false): Promise<number> {
  const result = await dockerTry(danglingImagePruneArgs(deep), { timeout: 120_000 });
  return parseReclaimed(result?.stdout ?? "");
}

/** Kept for the callers that only ever meant the routine pass. */
export async function pruneDanglingOwned(): Promise<number> {
  return pruneDangling(false);
}

/**
 * Build cache is not labelled by Docker, so this is all-or-nothing by age.
 * Zero hours means all of it.
 */
export async function pruneBuildCache(keepHours: number): Promise<number> {
  const result = await dockerTry(buildCachePruneArgs(keepHours), { timeout: 300_000 });
  return parseReclaimed(result?.stdout ?? "");
}

/** Re-exported: the parser lives with the rest of the clean's arithmetic. */
export { parseReclaimed };

/**
 * Images compose built for a RunPanel project that no longer exists.
 *
 * Compose stamps `com.docker.compose.project` on what it builds and refuses
 * our labels, so these were invisible to every clean, and deleting a compose
 * project left its images behind.
 */
export async function listComposeOrphanImages(knownSlugs: ReadonlySet<string>): Promise<string[]> {
  // The id list first, then an inspect for the labels: the `images` formatter
  // has no access to labels at all, and asking for one fails the whole call.
  const ids = await dockerTry(["images", "--filter", "label=com.docker.compose.project", "-q"]);
  const unique = [...new Set(lines(ids?.stdout ?? ""))];
  if (unique.length === 0) return [];

  const result = await dockerTry(
    [
      "image",
      "inspect",
      "--format",
      '{{.Id}}{{"\\t"}}{{index .Config.Labels "com.docker.compose.project"}}{{"\\t"}}{{range .RepoTags}}{{.}} {{end}}',
      ...unique,
    ],
    { timeout: 60_000 }
  );
  if (!result) return [];

  // One entry per name, or the id when compose's image has none left, so the
  // removal takes every name and the image with them.
  const images = lines(result.stdout).flatMap((line) => {
    const [id, project, tags] = line.split("\t");
    const names = (tags ?? "").split(" ").filter(Boolean);
    const composeProject = project && project !== "<no value>" ? project : null;
    return (names.length > 0 ? names : [id]).map((ref) => ({ ref, composeProject }));
  });
  return composeOrphanImages(images, knownSlugs);
}

/**
 * Remove every image no container uses, except RunPanel's rollback tags.
 * Opt-in only — see `unusedImageRefs` for why, and for why this does not
 * lean on `image prune -a`.
 */
export async function removeUnusedImages(): Promise<string[]> {
  const [all, owned, containers] = await Promise.all([
    dockerTry(["images", "--format", "{{.ID}}\t{{.Repository}}:{{.Tag}}"]),
    dockerTry(["images", ...ownedFilters(), "-q"]),
    dockerTry(["ps", "-aq", "--no-trunc"]),
  ]);
  if (!all || !owned || !containers) return [];

  const ids = lines(containers.stdout);
  const used =
    ids.length === 0
      ? null
      : await dockerTry(["inspect", "--format", "{{.Image}}", ...ids], { timeout: 60_000 });
  // An inspect that failed says nothing about which images are in use, and
  // guessing "none" would offer every image on the host for deletion.
  if (ids.length > 0 && !used) return [];

  const refs = unusedImageRefs(
    lines(all.stdout).map((line) => {
      const [id, ref] = line.split("\t");
      return { id, ref };
    }),
    new Set(lines(owned.stdout)),
    new Set(used ? lines(used.stdout) : [])
  );

  const removed: string[] = [];
  for (const ref of refs) {
    // No `-f`: an image a container started using in the meantime is refused
    // by the daemon rather than pulled out from under it.
    if (await dockerTry(["rmi", ref], { timeout: 60_000 })) removed.push(ref);
  }
  return removed;
}

/** Pull a template image, stamping it as ours so the GC can account for it. */
export async function pullImage(
  image: string,
  onLog?: (line: string) => void,
  timeout = 300_000
): Promise<void> {
  onLog?.(`> docker pull ${image}`);
  const result = await docker(["pull", image], { timeout });
  for (const line of lines(result.stdout)) onLog?.(line);
}

export { labelArgs };
