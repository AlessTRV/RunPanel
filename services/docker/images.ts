import { docker, dockerTry, lines } from "./cli";
import { imageRepo, labelArgs, ownedFilters } from "./labels";

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
 * Dangling images RunPanel produced. Scoped by label so a prune here can never
 * touch an unrelated dangling image belonging to the user.
 */
export async function pruneDanglingOwned(): Promise<number> {
  const result = await dockerTry([
    "image",
    "prune",
    "-f",
    ...ownedFilters(),
    "--filter",
    "dangling=true",
  ], { timeout: 120_000 });

  return parseReclaimed(result?.stdout ?? "");
}

/** Build cache is not labelled by Docker, so this is all-or-nothing by age. */
export async function pruneBuildCache(keepHours: number): Promise<number> {
  const result = await dockerTry(
    ["builder", "prune", "-f", "--filter", `until=${keepHours}h`],
    { timeout: 120_000 }
  );
  return parseReclaimed(result?.stdout ?? "");
}

/** Docker prints "Total reclaimed space: 1.23GB" — turn that into bytes. */
export function parseReclaimed(stdout: string): number {
  const match = stdout.match(/Total reclaimed space:\s*([\d.]+)\s*([KMGT]?B)/i);
  if (!match) return 0;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return 0;

  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
  };
  return amount * (multipliers[unit] ?? 1);
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
