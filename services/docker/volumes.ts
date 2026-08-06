import { dockerTry, lines } from "./cli";
import { labelArgs, ownedFilters, type OwnershipLabels } from "./labels";

/**
 * Volume lifecycle.
 *
 * Previously volumes were created implicitly by `docker run -v name:/path`,
 * which produces an *unlabelled* volume, and deleting a service only ran
 * `docker rm -f` on the container. The named volume survived forever — so the
 * database files stayed on disk, and recreating a service with the same name
 * silently reattached the old data instead of starting clean.
 *
 * Creating them explicitly, with labels, is what makes both problems fixable.
 */

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
}

const VOLUME_FORMAT = "{{.Name}}\t{{.Driver}}\t{{.Mountpoint}}";

function parseVolumes(stdout: string): VolumeInfo[] {
  return lines(stdout).map((line) => {
    const [name, driver, mountpoint] = line.split("\t");
    return { name, driver, mountpoint };
  });
}

/**
 * Create the volume up front so it carries ownership labels. Docker treats this
 * as idempotent: creating an existing volume is a no-op that returns its name.
 */
export async function ensureVolume(name: string, labels: OwnershipLabels): Promise<void> {
  await dockerTry(["volume", "create", ...labelArgs(labels), name]);
}

export async function listOwnedVolumes(labels: OwnershipLabels = {}): Promise<VolumeInfo[]> {
  const result = await dockerTry(["volume", "ls", ...ownedFilters(labels), "--format", VOLUME_FORMAT]);
  return result ? parseVolumes(result.stdout) : [];
}

export async function removeVolumes(names: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const name of names) {
    // Fails while a container still references it, which is the desired
    // behaviour — the caller removes the container first.
    if (await dockerTry(["volume", "rm", name], { timeout: 30_000 })) removed.push(name);
  }
  return removed;
}

/** Every volume belonging to a project. Destructive to remove — it is the data. */
export async function removeProjectVolumes(slug: string): Promise<string[]> {
  const volumes = await listOwnedVolumes({ project: slug });
  return removeVolumes(volumes.map((v) => v.name));
}
