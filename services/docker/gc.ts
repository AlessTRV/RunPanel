import { getDb } from "@/lib/db";
import { dockerTry, isDockerAvailable, lines } from "./cli";
import { LABEL_PROJECT, ownedFilters, parseLabels } from "./labels";
import {
  listOwnedImages,
  pruneBuildCache,
  pruneDanglingOwned,
  pruneProjectImages,
  removeImages,
} from "./images";
import { removeVolumes } from "./volumes";
import { pruneBuildLogs } from "../build-logs";

/**
 * Housekeeping.
 *
 * Nothing in RunPanel used to reclaim anything: there was no `image prune`,
 * `volume rm`, `builder prune` or `system df` anywhere in the codebase. On a
 * long-lived host that is an unbounded disk leak — one orphaned image set per
 * Docker redeploy, plus every volume of every service ever deleted.
 *
 * Everything here is scoped by the ownership labels. A resource without
 * `runpanel.managed=true` is never a candidate, whatever its name looks like.
 */

export interface RetentionPolicy {
  /** Immutable image tags to keep per project, newest first. */
  imagesPerProject: number;
  /** Build cache older than this is dropped. */
  buildCacheHours: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  imagesPerProject: 2,
  buildCacheHours: 168, // one week
};

export interface OrphanReport {
  containers: string[];
  images: string[];
  volumes: string[];
  networks: string[];
}

export interface SweepResult extends OrphanReport {
  reclaimedBytes: number;
  prunedImageTags: string[];
  skipped?: string;
}

/** The set of project slugs that currently exist. Anything else is an orphan. */
async function knownSlugs(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.selectFrom("projects").select("slug").execute();
  return new Set(rows.map((r) => r.slug));
}

/**
 * Resources RunPanel owns whose project no longer exists in the store.
 *
 * Read-only: this is what the Storage page shows before anyone presses a
 * destructive button.
 */
export async function findOrphans(): Promise<OrphanReport> {
  const empty: OrphanReport = { containers: [], images: [], volumes: [], networks: [] };
  if (!(await isDockerAvailable())) return empty;

  const slugs = await knownSlugs();
  const orphaned = (slug: string | null) => slug !== null && !slugs.has(slug);

  // Every docker CLI call costs hundreds of milliseconds, so these run
  // concurrently and each resource type is listed exactly once — labels come
  // from the listing itself rather than an inspect per object.
  const [containersOut, ownedImages, volumesOut, networksOut] = await Promise.all([
    dockerTry(["ps", "-a", ...ownedFilters(), "--format", "{{.Names}}\t{{.Labels}}"]),
    listOwnedImages(),
    dockerTry(["volume", "ls", ...ownedFilters(), "--format", "{{.Name}}\t{{.Labels}}"]),
    dockerTry(["network", "ls", ...ownedFilters(), "--format", "{{.Name}}"]),
  ]);

  const containers = lines(containersOut?.stdout ?? "")
    .map((line) => {
      const [name, labels] = line.split("\t");
      return { name, project: parseLabels(labels)[LABEL_PROJECT] ?? null };
    })
    .filter((c) => orphaned(c.project))
    .map((c) => c.name);

  const images = ownedImages
    .filter((image) => {
      const slug = image.repository.startsWith("runpanel/")
        ? image.repository.slice("runpanel/".length)
        : null;
      return orphaned(slug);
    })
    .map((image) => (image.tag === "<none>" ? image.id : `${image.repository}:${image.tag}`));

  const volumes = lines(volumesOut?.stdout ?? "")
    .map((line) => {
      const [name, labels] = line.split("\t");
      return { name, project: parseLabels(labels)[LABEL_PROJECT] ?? null };
    })
    .filter((v) => orphaned(v.project))
    .map((v) => v.name);

  const networks = lines(networksOut?.stdout ?? "").filter((name) => {
    const slug = name.startsWith("runpanel-net-") ? name.slice("runpanel-net-".length) : null;
    return orphaned(slug);
  });

  return { containers, images, volumes, networks };
}

/**
 * Reclaim space.
 *
 * `removeOrphans` is opt-in because orphaned volumes hold data: a project
 * deleted by accident can still be recovered from its volume until this runs.
 */
export async function sweep(
  options: { retention?: RetentionPolicy; removeOrphans?: boolean; project?: string } = {}
): Promise<SweepResult> {
  const retention = options.retention ?? DEFAULT_RETENTION;
  const result: SweepResult = {
    containers: [],
    images: [],
    volumes: [],
    networks: [],
    reclaimedBytes: 0,
    prunedImageTags: [],
  };

  if (!(await isDockerAvailable())) {
    return { ...result, skipped: "Docker non è raggiungibile" };
  }

  // 1. Retention on per-project images.
  const slugs = options.project ? [options.project] : [...(await knownSlugs())];
  for (const slug of slugs) {
    result.prunedImageTags.push(...(await pruneProjectImages(slug, retention.imagesPerProject)));
  }

  // 2. Orphans, only when asked.
  if (options.removeOrphans) {
    const orphans = await findOrphans();

    for (const name of orphans.containers) {
      if (await dockerTry(["rm", "-f", name], { timeout: 30_000 })) result.containers.push(name);
    }
    await removeImages(orphans.images);
    result.images.push(...orphans.images);
    result.volumes.push(...(await removeVolumes(orphans.volumes)));
    for (const name of orphans.networks) {
      if (await dockerTry(["network", "rm", name])) result.networks.push(name);
    }
  }

  // 3. Dangling images we produced, then build cache.
  result.reclaimedBytes += await pruneDanglingOwned();
  result.reclaimedBytes += await pruneBuildCache(retention.buildCacheHours);

  // 4. Build logs whose deployment row is gone. Deployments cascade away with
  // their project, but the log files sit outside the database and would
  // otherwise accumulate forever.
  try {
    const db = await getDb();
    const rows = await db.selectFrom("deployments").select("id").execute();
    pruneBuildLogs(new Set(rows.map((r) => r.id)));
  } catch (err) {
    console.error("[gc] Could not prune build logs:", err);
  }

  return result;
}

/**
 * Periodic housekeeping.
 *
 * The per-project sweep after a successful deploy covers the common case, but
 * not a project deleted while Docker was unreachable, or build cache that ages
 * out with no deploy to trigger a pass. Retention only — orphans still need a
 * human, because removing them destroys data.
 */
const GC_INTERVAL_MS = 6 * 60 * 60 * 1000;

const globalRef = globalThis as typeof globalThis & { __runpanelGcTimer?: NodeJS.Timeout };

export function startGcScheduler(): void {
  if (globalRef.__runpanelGcTimer) return;

  const tick = async () => {
    try {
      const result = await sweep({ removeOrphans: false });
      if (result.reclaimedBytes > 0 || result.prunedImageTags.length > 0) {
        console.log(
          `[gc] Reclaimed ${(result.reclaimedBytes / 1024 ** 2).toFixed(0)} MB, ` +
            `retired ${result.prunedImageTags.length} image(s)`
        );
      }
    } catch (err) {
      console.error("[gc] Scheduled sweep failed:", err);
    }
  };

  globalRef.__runpanelGcTimer = setInterval(tick, GC_INTERVAL_MS);
  // Never hold the process open for a housekeeping timer.
  globalRef.__runpanelGcTimer.unref?.();
}

export function stopGcScheduler(): void {
  if (!globalRef.__runpanelGcTimer) return;
  clearInterval(globalRef.__runpanelGcTimer);
  globalRef.__runpanelGcTimer = undefined;
}

export interface DiskUsageEntry {
  type: string;
  total: number;
  active: number;
  size: string;
  reclaimable: string;
}

/** `docker system df`, for the Storage page. */
export async function diskUsage(): Promise<DiskUsageEntry[]> {
  if (!(await isDockerAvailable())) return [];

  const result = await dockerTry([
    "system", "df", "--format", "{{.Type}}\t{{.TotalCount}}\t{{.Active}}\t{{.Size}}\t{{.Reclaimable}}",
  ], { timeout: 30_000 });

  return lines(result?.stdout ?? "").map((line) => {
    const [type, total, active, size, reclaimable] = line.split("\t");
    return {
      type,
      total: Number.parseInt(total, 10) || 0,
      active: Number.parseInt(active, 10) || 0,
      size: size ?? "0B",
      reclaimable: reclaimable ?? "0B",
    };
  });
}
