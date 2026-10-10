import { getDb, rowCount } from "@/lib/db";
import { pruneRateLimits } from "@/lib/rate-limit";
import { pruneAudit } from "@/lib/audit";
import { dockerTry, isDockerAvailable, lines } from "./cli";
import { LABEL_KIND, LABEL_PROJECT, ownedFilters, parseLabels } from "./labels";
import { serviceVolumeNames } from "../service-provisioner";
import {
  listComposeOrphanImages,
  listOwnedImages,
  pruneBuildCache,
  pruneDangling,
  pruneProjectImages,
  removeImages,
  removeUnusedImages,
} from "./images";
import { footprintFromDf } from "@/lib/docker-cleanup";
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
  /** Images no container used, removed because the operator asked for them. */
  unusedImages: string[];
  skipped?: string;
}

export interface SweepOptions {
  retention?: RetentionPolicy;
  /** Every orphan, volumes included — volumes hold data, so a human asks. */
  removeOrphans?: boolean;
  /**
   * What the Storage page's button asks for: the orphans that hold no data
   * (containers, images, networks), and every image with no tag whoever
   * built it. Never from the periodic pass: a service's container is created
   * a moment before its row, and a timer landing in between would call it an
   * orphan.
   */
  deep?: boolean;
  /** Also every image no container uses — the operator's own included. */
  unusedImages?: boolean;
  project?: string;
}

/**
 * Everything Docker holds on this host, in bytes.
 *
 * The only honest measure of a clean. A prune's own total covers the prune
 * alone, `docker rmi` prints no size at all, and under the containerd image
 * store even a prune's total counts the manifests and not the layers — so a
 * clean that removed gigabytes of images could report kilobytes. Before minus
 * after is what the disk actually got back, give or take the rounding of
 * `system df`.
 */
async function dockerFootprint(): Promise<number | null> {
  const result = await dockerTry(["system", "df", "--format", "{{.Type}}\t{{.Size}}"], { timeout: 60_000 });
  return result ? footprintFromDf(result.stdout) : null;
}

/** The set of project slugs that currently exist. Anything else is an orphan. */
async function knownSlugs(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.selectFrom("projects").select("slug").execute();
  return new Set(rows.map((r) => r.slug));
}

/**
 * The containers and volumes belonging to a service row that still exists.
 *
 * Needed because a service with no project carries no `runpanel.project` label,
 * and the project rule below reads a missing label as "not ours to judge". That
 * is the right default — but it also meant a standalone service whose row went
 * away (a Docker removal that failed and was swallowed, a hand-edited store)
 * left a container and a database volume that nothing could ever reclaim, on a
 * page whose whole purpose is reclaiming things.
 */
async function knownServiceResources(): Promise<{ containers: Set<string>; volumes: Set<string> }> {
  const db = await getDb();
  const services = await db
    .selectFrom("services")
    .leftJoin("projects", "projects.id", "services.project_id")
    .select(["services.name", "services.type", "services.container_name", "projects.slug"])
    .execute();

  const containers = new Set<string>();
  const volumes = new Set<string>();

  for (const service of services) {
    containers.add(service.container_name);
    // Derived rather than recorded, and generously: erring towards "known"
    // leaks disk, erring towards "orphan" offers a live database for deletion.
    for (const name of serviceVolumeNames({
      type: service.type,
      name: service.name,
      projectSlug: service.slug,
    })) {
      volumes.add(name);
    }
  }

  return { containers, volumes };
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

  const [slugs, knownService] = await Promise.all([knownSlugs(), knownServiceResources()]);
  const orphaned = (slug: string | null) => slug !== null && !slugs.has(slug);

  /**
   * A resource with no project label is judged by its service instead — but
   * only when it says it is a service. Anything else with no project stays out
   * of the report: a false "known" wastes disk, a false "orphan" puts a live
   * database in a delete-everything button.
   */
  const orphanedResource = (
    name: string,
    labels: Record<string, string>,
    known: Set<string>
  ): boolean => {
    const project = labels[LABEL_PROJECT] ?? null;
    if (project !== null) return orphaned(project);
    return labels[LABEL_KIND] === "service" && !known.has(name);
  };

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
      return { name, labels: parseLabels(labels) };
    })
    .filter((c) => orphanedResource(c.name, c.labels, knownService.containers))
    .map((c) => c.name);

  const images = ownedImages
    .filter((image) => {
      const slug = image.repository.startsWith("runpanel/")
        ? image.repository.slice("runpanel/".length)
        : null;
      return orphaned(slug);
    })
    .map((image) => (image.tag === "<none>" ? image.id : `${image.repository}:${image.tag}`));

  // What compose built for a project that is gone. Its images carry compose's
  // labels rather than ours, so the listing above never saw them.
  images.push(...(await listComposeOrphanImages(slugs)));

  const volumes = lines(volumesOut?.stdout ?? "")
    .map((line) => {
      const [name, labels] = line.split("\t");
      return { name, labels: parseLabels(labels) };
    })
    .filter((v) => orphanedResource(v.name, v.labels, knownService.volumes))
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
export async function sweep(options: SweepOptions = {}): Promise<SweepResult> {
  const retention = options.retention ?? DEFAULT_RETENTION;
  const result: SweepResult = {
    containers: [],
    images: [],
    volumes: [],
    networks: [],
    reclaimedBytes: 0,
    prunedImageTags: [],
    unusedImages: [],
  };

  if (!(await isDockerAvailable())) {
    return { ...result, skipped: "Docker non è raggiungibile" };
  }

  // Not after a deploy: that pass is scoped to one project, nobody reads its
  // total, and `system df` can take seconds on a host with many images.
  const before = options.project ? null : await dockerFootprint();
  // What the prunes say they freed: a floor under the measured figure, for
  // when `system df` could not be read.
  let reported = 0;

  // 1. Retention on per-project images.
  const slugs = options.project ? [options.project] : [...(await knownSlugs())];
  for (const slug of slugs) {
    result.prunedImageTags.push(...(await pruneProjectImages(slug, retention.imagesPerProject)));
  }

  // 2. Orphans. The ones that hold no data on the deep pass; volumes too only
  // when a human asked for exactly that.
  if (options.removeOrphans || options.deep) {
    const orphans = await findOrphans();

    for (const name of orphans.containers) {
      if (await dockerTry(["rm", "-f", name], { timeout: 30_000 })) result.containers.push(name);
    }
    await removeImages(orphans.images);
    result.images.push(...orphans.images);
    if (options.removeOrphans) {
      result.volumes.push(...(await removeVolumes(orphans.volumes)));
    }
    for (const name of orphans.networks) {
      if (await dockerTry(["network", "rm", name])) result.networks.push(name);
    }
  }

  // 3. Images with no tag — ours on the routine pass, all of them on the deep
  // one — then, when asked, every image nothing uses. After the orphans, so
  // the layers an orphaned image was holding go in the same pass.
  reported += await pruneDangling(options.deep ?? false);
  if (options.unusedImages) {
    result.unusedImages.push(...(await removeUnusedImages()));
  }

  // 4. Build cache, by age; zero hours is all of it.
  reported += await pruneBuildCache(retention.buildCacheHours);

  const after = before === null ? null : await dockerFootprint();
  const measured = before !== null && after !== null ? Math.max(0, before - after) : 0;
  result.reclaimedBytes = Math.max(measured, reported);

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

/** History worth keeping for a panel nobody is auditing. */
const DEPLOYMENT_RETENTION_DAYS = 90;
const WEBHOOK_RETENTION_DAYS = 30;
/** Spent one-time commands. Long enough to answer "did that chore run?". */
const ONE_TIME_RETENTION_DAYS = 90;

/**
 * The rows nothing else collects.
 *
 * These tables only ever grew. `deployments` gains a row per push and is
 * read with a `GROUP BY` over the whole table on an endpoint polled every 5
 * seconds; `webhook_deliveries` gains one per delivery and is read back only as
 * the last handful on a project's settings tab; `rate_limits` keys on a client
 * address, so every distinct one left something behind.
 *
 * The newest deployment of each project is always kept, however old. A project
 * that last shipped a year ago should still be able to say when.
 */
async function pruneStore(): Promise<void> {
  const db = await getDb();
  const cutoff = (days: number) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rateLimits = await pruneRateLimits();

  // One small query per project rather than a correlated subquery. Ids are
  // random nanoids, so `max(id)` is not the newest row — it is alphabetical
  // noise — and this runs every six hours over a handful of projects.
  const owners = await db.selectFrom("deployments").select("project_id").distinct().execute();
  const keep: string[] = [];
  for (const { project_id } of owners) {
    const newest = await db
      .selectFrom("deployments")
      .select("id")
      .where("project_id", "=", project_id)
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (newest) keep.push(newest.id);
  }

  let deployments = db
    .deleteFrom("deployments")
    .where("started_at", "<", cutoff(DEPLOYMENT_RETENTION_DAYS));
  if (keep.length > 0) deployments = deployments.where("id", "not in", keep);

  const deployed = rowCount(await deployments.executeTakeFirst());

  const webhooks = rowCount(
    await db
      .deleteFrom("webhook_deliveries")
      .where("received_at", "<", cutoff(WEBHOOK_RETENTION_DAYS))
      .executeTakeFirst()
  );

  // Spent one-time commands only. A `queued` row is configuration an
  // operator wrote and a `claimed` one is work in flight, and neither
  // becomes collectable by sitting still for ninety days.
  const oneTime = rowCount(
    await db
      .deleteFrom("one_time_commands")
      .where("status", "in", ["done", "failed"])
      .where("finished_at", "<", cutoff(ONE_TIME_RETENTION_DAYS))
      .executeTakeFirst()
  );

  // The activity log keeps what the owner chose in the settings, 90 days by default.
  const audited = await pruneAudit();

  if (rateLimits + deployed + webhooks + oneTime + audited > 0) {
    console.log(
      `[gc] Store: ${deployed} deployment(s), ${webhooks} webhook delivery(ies), ` +
        `${oneTime} spent one-time command(s), ${rateLimits} rate-limit window(s), ${audited} audit entry(ies)`
    );
  }
}

const globalRef = globalThis as typeof globalThis & { __runpanelGcTimer?: NodeJS.Timeout };

export function startGcScheduler(): void {
  if (globalRef.__runpanelGcTimer) return;

  const tick = async () => {
    // Store housekeeping rides along on this timer rather than starting a
    // second one, and goes first: it has nothing to do with Docker, so a host
    // where the daemon is down must not be a host where it never runs.
    try {
      await pruneStore();
    } catch (err) {
      console.error("[gc] Store housekeeping failed:", err);
    }

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
