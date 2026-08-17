import { dockerTry, lines } from "./cli";
import { labelArgs, ownedFilters, type OwnershipLabels } from "./labels";

// Re-exported so a caller reaching for "how do I read a -v mapping" finds it
// here, next to the volumes it decides the fate of. The rules themselves live
// in `lib/mount.ts`, which imports nothing and so can be unit-checked.
export { isHostPath, mountSource } from "@/lib/mount";

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

export interface ContainerMount {
  /** Empty for a bind mount — only a managed volume has a name. */
  name: string;
  source: string;
  destination: string;
}

/*
  `|` and not a tab, which is not a nicety.

  A bind mount has no `.Name`, so its line begins with the separator — and
  `lines()` trims each line before handing it over, which swallows a leading tab
  and shifts every field one to the left. The mount then reported its *source*
  as its name and its *destination* as its source, and a caller matching on the
  destination found nothing. A pipe survives the trim; it is also what the
  monitor's own inspect format has always used.
*/
const MOUNT_FORMAT = '{{range .Mounts}}{{.Name}}|{{.Source}}|{{.Destination}}{{"\\n"}}{{end}}';

/**
 * Where a container's data actually is, as Docker sees it.
 *
 * Asked rather than re-derived from the service name. Re-deriving is how the
 * Redis restore came to write into a volume that did not exist: it rebuilt the
 * name with no project slug, `docker run -v` created that empty volume, the
 * dump went in, and the container restarted on the real one — a restore that
 * restored nothing and said so nowhere. Docker knows; ask Docker.
 */
export async function containerMounts(container: string): Promise<ContainerMount[]> {
  const result = await dockerTry(["inspect", "-f", MOUNT_FORMAT, container], { timeout: 15_000 });
  if (!result) return [];

  return lines(result.stdout).map((line) => {
    const [name, source, destination] = line.split("|");
    return { name: name ?? "", source: source ?? "", destination: destination ?? "" };
  });
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
