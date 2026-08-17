import { getDb, nowIso, rowCount } from "@/lib/db";
import type { RuntimeType } from "@/lib/db/schema";
import { isReconcilable, reconciledStatus } from "@/lib/status";
import { dockerTry, lines } from "./docker/cli";
import { appContainerName } from "./docker/labels";
import { processManager } from "./process-manager";

/**
 * Making the status column mean what it says.
 *
 * Nothing in the panel ever asked. `projects.status` and `services.status` were
 * written by a deploy, by the control buttons and by the crash recovery pass,
 * and then believed forever — so a project whose process died without the panel
 * being told kept a green dot in the list, on the home page and in the monitor,
 * for as long as the row survived. The case that surfaced it: shutting the
 * panel down took its children down with it, and the panel came back still
 * claiming every one of them was running.
 *
 * This sweep asks. It starts nothing and stops nothing — bringing things back
 * after a reboot is `autostart/reconcile.ts`, which is opt-in per project for
 * good reasons; all this does is write down what is true.
 *
 * Two rules make it safe to run unattended:
 *
 *  - **A driver that cannot answer has not answered.** `docker ps` failing
 *    because the daemon is down says nothing about the containers, and reading
 *    it as "everything is stopped" would turn a Docker restart into a panel
 *    full of red. Those rows are skipped, not corrected.
 *  - **Going down is confirmed before it is written**, once per sweep — see
 *    `reconciledStatus()` in `lib/status.ts` for why one reading is not enough.
 */

/**
 * Half a minute is chosen against the pages that read the column, not against
 * the drivers: the project list and the monitor both poll every few seconds, so
 * a status corrected here shows up almost at once. The cost per sweep is one
 * `docker ps`, one `pm2 jlist` — shared with every other caller through that
 * driver's cache — and one `docker compose ps` per compose project.
 */
const SWEEP_MS = 30_000;

/**
 * The first sweep waits for the same reason `autostart/reconcile.ts` waits, and
 * a little longer: Docker's own `unless-stopped` restarts are still landing in
 * the first half-minute after a boot, and the reconciler may still be bringing
 * back what Docker did not.
 */
const FIRST_SWEEP_DELAY_MS = 45_000;

const globalRef = globalThis as typeof globalThis & {
  __runpanelStatusTimer?: NodeJS.Timeout;
  __runpanelStatusFirstSweep?: NodeJS.Timeout;
  /** What the previous sweep observed, keyed `table:id`. */
  __runpanelStatusSeen?: Map<string, boolean>;
  __runpanelStatusInFlight?: Promise<ReconcileStatusResult>;
};

export interface ReconcileStatusResult {
  /** Rows whose status was wrong and has been corrected. */
  projects: number;
  services: number;
}

export function startStatusReconciler(): void {
  if (globalRef.__runpanelStatusTimer) return;

  globalRef.__runpanelStatusTimer = setInterval(() => void sweep(), SWEEP_MS);
  globalRef.__runpanelStatusTimer.unref?.();

  globalRef.__runpanelStatusFirstSweep = setTimeout(() => void sweep(), FIRST_SWEEP_DELAY_MS);
  globalRef.__runpanelStatusFirstSweep.unref?.();
}

/** A sweep that logs its own failure instead of taking the timer down with it. */
async function sweep(): Promise<void> {
  try {
    const result = await reconcileStatuses();
    // Counted in both directions — a row that claimed to be running and was
    // not, and one that had come back up without the panel being told.
    if (result.projects > 0 || result.services > 0) {
      console.log(
        `[status] Corrected ${result.projects} project(s) and ${result.services} service(s) ` +
          `whose status disagreed with the machine`
      );
    }
  } catch (err) {
    console.error("[status] Reconciliation failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Compare every stored status with the process manager and write back the
 * differences.
 *
 * Concurrent callers share one pass: the boot reconciler finishes inside the
 * window where the timer fires its first sweep, and running both would ask
 * every driver twice and let the two disagree about what the previous
 * observation was.
 */
export function reconcileStatuses(): Promise<ReconcileStatusResult> {
  if (globalRef.__runpanelStatusInFlight) return globalRef.__runpanelStatusInFlight;

  const pass = runSweep().finally(() => {
    globalRef.__runpanelStatusInFlight = undefined;
  });
  globalRef.__runpanelStatusInFlight = pass;
  return pass;
}

async function runSweep(): Promise<ReconcileStatusResult> {
  const db = await getDb();
  const [projects, services] = await Promise.all([
    db.selectFrom("projects").select(["id", "slug", "status", "runtime_type"]).execute(),
    db.selectFrom("services").select(["id", "container_name", "status"]).execute(),
  ]);

  const containers = await runningContainers();

  const previous = globalRef.__runpanelStatusSeen ?? new Map<string, boolean>();
  // Rebuilt rather than mutated, so a deleted project does not leave its last
  // observation in the map for the lifetime of the process.
  const seen = new Map<string, boolean>();

  const result: ReconcileStatusResult = { projects: 0, services: 0 };

  for (const project of projects) {
    if (!isReconcilable(project.status)) continue;

    const observed = await projectRunning(project, containers);
    if (observed === null) continue;

    const key = `project:${project.id}`;
    seen.set(key, observed);

    const next = reconciledStatus(project.status, observed, previous.get(key));
    if (!next) continue;

    const updated = await db
      .updateTable("projects")
      .set({ status: next, updated_at: nowIso() })
      .where("id", "=", project.id)
      // Only if nothing has moved the row since it was read. A deploy that
      // started while the drivers were being asked has already written
      // `deploying`, and this answer describes the world before it — the same
      // conditional update `deploy-queue.claim()` uses, for the same reason.
      .where("status", "=", project.status)
      .executeTakeFirst();

    if (rowCount(updated) > 0) result.projects++;
  }

  if (containers) {
    for (const service of services) {
      if (!isReconcilable(service.status)) continue;

      const observed = containers.has(service.container_name);
      const key = `service:${service.id}`;
      seen.set(key, observed);

      const next = reconciledStatus(service.status, observed, previous.get(key));
      if (!next) continue;

      const updated = await db
        .updateTable("services")
        .set({ status: next, updated_at: nowIso() })
        .where("id", "=", service.id)
        .where("status", "=", service.status)
        .executeTakeFirst();

      if (rowCount(updated) > 0) result.services++;
    }
  }

  globalRef.__runpanelStatusSeen = seen;
  return result;
}

/**
 * The names of every container currently up, or `null` if Docker could not be
 * asked.
 *
 * `docker ps` rather than an inspect per name: an inspect batch fails whole
 * when one of its names is unknown, and a container removed behind the panel's
 * back is precisely the case this sweep exists for. A listing of what is
 * running cannot fail that way — anything absent from it is down or gone, and
 * both mean the same thing here.
 *
 * `{{.Names}}` alone, without `{{.State}}`: every container `docker ps` prints
 * without `-a` is up, so the state adds a field whose spelling has changed
 * between Docker versions in exchange for nothing.
 */
async function runningContainers(): Promise<Set<string> | null> {
  const result = await dockerTry(["ps", "--format", "{{.Names}}"], { timeout: 15_000 });
  if (!result) return null;

  // One container can carry several names, comma-separated.
  const names = new Set<string>();
  for (const line of lines(result.stdout)) {
    for (const name of line.split(",")) {
      const trimmed = name.trim();
      if (trimmed) names.add(trimmed);
    }
  }
  return names;
}

/**
 * Whether a project's app is up. `null` means nothing could be asked, which is
 * not the same as "it is down" and must never be written as it.
 */
async function projectRunning(
  project: { slug: string; runtime_type: RuntimeType },
  containers: Set<string> | null
): Promise<boolean | null> {
  // A Docker project's container name is derivable, so the listing already read
  // answers for all of them without a call each.
  if (project.runtime_type === "docker") {
    return containers ? containers.has(appContainerName(project.slug)) : null;
  }

  // A compose stack is up only when every one of its services is, which is a
  // judgement the driver already makes — but it makes it by catching its own
  // errors and answering "not running", so with the daemon down it would
  // report a stack that is fine as stopped.
  if (project.runtime_type === "compose" && containers === null) return null;

  try {
    const info = await processManager.status(project.slug, project.runtime_type);
    return info.running;
  } catch {
    return null;
  }
}
