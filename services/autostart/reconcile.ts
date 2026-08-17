import { compareAutostart, resolveAutostart, type AutostartKind } from "@/lib/autostart";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { setSetting, getSetting } from "@/lib/settings";
import { docker, dockerTry } from "../docker/cli";
import { HOST_CHANNEL, opsEvents } from "../events";
import { AppendLogFile } from "../log-file";
import { processManager } from "../process-manager";
import { execArgs, serviceTarget } from "../service-databases";
import { reconcileStatuses } from "../status-reconcile";
import path from "path";
import { config } from "@/lib/config";

/**
 * Bringing back what is supposed to be running, after a reboot.
 *
 * This is a **repair** pass, not a start pass. Docker's own `unless-stopped`
 * has already brought most things up by the time this runs; the reconciler
 * waits for that to settle and then looks at what is *still* down. Written the
 * other way round it would race Docker and restart containers Docker was
 * already restarting.
 *
 * The one rule it never breaks: it does not build anything. A boot that starts
 * pulling from GitHub is a boot that can fail in a hundred new ways, at the
 * exact moment nobody is watching.
 */

/** Long enough for Docker to have finished its own restarts. */
const SETTLE_MS = 20_000;
/** Between items, so ten projects do not all hit the disk at once. */
const GAP_MS = 2_000;
const READY_TIMEOUT_MS = 60_000;

export const REPORT_SETTING = "autostart_last_report";

export type EntryAction = "started" | "already-running" | "skipped" | "failed" | "would-start";

export interface ReconcileEntry {
  kind: AutostartKind;
  id: string;
  name: string;
  order: number;
  action: EntryAction;
  detail: string;
}

export interface ReconcileReport {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  entries: ReconcileEntry[];
  started: number;
  failed: number;
}

const globalRef = globalThis as typeof globalThis & {
  __runpanelAutostartTimer?: NodeJS.Timeout;
  __runpanelAutostartDone?: boolean;
};

/**
 * Scheduled, never awaited. Holding `register()` for ninety seconds while ten
 * projects come up delays the first HTTP response and makes the panel look
 * dead at exactly the moment someone is checking whether it survived the
 * reboot.
 */
export function startAutostartReconciler(): void {
  if (globalRef.__runpanelAutostartTimer || globalRef.__runpanelAutostartDone) return;

  globalRef.__runpanelAutostartTimer = setTimeout(() => {
    globalRef.__runpanelAutostartDone = true;
    void reconcileAutostart({ dryRun: false }).catch((err) => {
      console.error("[autostart] Riconciliazione fallita:", err);
    });
  }, SETTLE_MS);
  globalRef.__runpanelAutostartTimer.unref?.();
}


interface Candidate {
  kind: AutostartKind;
  id: string;
  name: string;
  order: number;
  createdAt: string;
  delaySeconds: number;
  waitHealthy: boolean;
  /** Services only. */
  containerName?: string;
  engine?: string;
  /** Projects only. */
  slug?: string;
  runtime?: string;
}

async function candidates(): Promise<Candidate[]> {
  const db = await getDb();
  const [services, projects] = await Promise.all([
    db.selectFrom("services").selectAll().execute(),
    db.selectFrom("projects").selectAll().execute(),
  ]);

  const out: Candidate[] = [];

  for (const service of services) {
    const settings = resolveAutostart("service", service);
    if (!settings.autostart) continue;
    out.push({
      kind: "service",
      id: service.id,
      name: service.name,
      order: settings.order,
      createdAt: service.created_at,
      delaySeconds: settings.delaySeconds,
      waitHealthy: settings.waitHealthy,
      containerName: service.container_name,
      engine: service.type,
    });
  }

  for (const project of projects) {
    const settings = resolveAutostart("project", project);
    if (!settings.autostart) continue;
    out.push({
      kind: "project",
      id: project.id,
      name: project.name,
      order: settings.order,
      createdAt: project.created_at,
      delaySeconds: settings.delaySeconds,
      waitHealthy: settings.waitHealthy,
      slug: project.slug,
      runtime: project.runtime_type,
    });
  }

  return out.sort(compareAutostart);
}

export async function reconcileAutostart(
  options: { dryRun?: boolean } = {}
): Promise<ReconcileReport> {
  const dryRun = options.dryRun ?? false;
  const startedAt = new Date().toISOString();
  const log = new AppendLogFile(path.join(config.logsDir, "autostart.log"));

  const emit = (line: string) => {
    log.append(`${new Date().toISOString()} ${line}`);
    opsEvents.emit(HOST_CHANNEL, { type: "autostart:log", line });
  };

  emit(dryRun ? "Simulazione dell'avvio automatico" : "Avvio automatico: riconciliazione");

  const entries: ReconcileEntry[] = [];
  const list = await candidates();
  emit(`${list.length} element${list.length === 1 ? "o" : "i"} da controllare`);

  for (const candidate of list) {
    const entry = await handle(candidate, dryRun, emit);
    entries.push(entry);

    if (!dryRun && entry.action === "started") {
      if (candidate.delaySeconds > 0) {
        await sleep(candidate.delaySeconds * 1000);
      }
      await sleep(GAP_MS);
    }
  }

  // What this pass just started is running, and what it found still down is
  // not — but none of that reached the status column, which is written by
  // deploys and by the control buttons and by nothing here. Left alone, a boot
  // that worked perfectly still ended with a panel describing the state of the
  // machine before the reboot. Skipped on a dry run, which changes nothing and
  // must not write anything either.
  if (!dryRun) {
    try {
      const corrected = await reconcileStatuses();
      if (corrected.projects > 0 || corrected.services > 0) {
        emit(
          `Stato allineato: ${corrected.projects} progetto/i e ${corrected.services} servizio/i corretti`
        );
      }
    } catch (err) {
      emit(`Stato non allineato: ${err instanceof Error ? err.message : err}`);
    }
  }

  const report: ReconcileReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun,
    entries,
    started: entries.filter((entry) => entry.action === "started").length,
    failed: entries.filter((entry) => entry.action === "failed").length,
  };

  emit(
    dryRun
      ? "Simulazione conclusa"
      : `Riconciliazione conclusa: ${report.started} avviati, ${report.failed} falliti`
  );
  log.flush();

  // A dry run is a question, not an event: it must not overwrite the record of
  // what actually happened at the last boot.
  if (!dryRun) await setSetting(REPORT_SETTING, JSON.stringify(report));

  return report;
}

async function handle(
  candidate: Candidate,
  dryRun: boolean,
  emit: (line: string) => void
): Promise<ReconcileEntry> {
  const base = {
    kind: candidate.kind,
    id: candidate.id,
    name: candidate.name,
    order: candidate.order,
  };

  try {
    const running = await isRunning(candidate);
    if (running) {
      // Almost always the case: Docker's own restart policy got there first.
      return { ...base, action: "already-running", detail: "Era già in esecuzione" };
    }

    if (dryRun) {
      return { ...base, action: "would-start", detail: "È fermo: verrebbe avviato" };
    }

    emit(`→ avvio ${candidate.kind === "service" ? "servizio" : "progetto"} ${candidate.name}`);

    if (candidate.kind === "service") {
      await docker(["start", candidate.containerName ?? ""], { timeout: 60_000 });
      if (candidate.waitHealthy) {
        const ready = await waitReady(candidate, emit);
        if (!ready) {
          return {
            ...base,
            action: "failed",
            detail: "Avviato ma non ha risposto alla sonda di prontezza entro un minuto",
          };
        }
      }
      return { ...base, action: "started", detail: "Avviato" };
    }

    // Projects: restart, never a fresh start. The container or the PM2 entry
    // already exists — recreating it is the deploy pipeline's job, and doing it
    // here would duplicate ports and rebuild images at boot.
    await processManager.restart(candidate.slug ?? "", candidate.runtime ?? "node");
    return { ...base, action: "started", detail: "Avviato" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(`✗ ${candidate.name}: ${message}`);
    return {
      ...base,
      action: "failed",
      detail:
        candidate.kind === "project"
          ? `${message} — se non è mai stato deployato con successo non c'è niente da riavviare`
          : message,
    };
  }
}

async function isRunning(candidate: Candidate): Promise<boolean> {
  if (candidate.kind === "service") {
    const inspected = await dockerTry(
      ["inspect", "-f", "{{.State.Running}}", candidate.containerName ?? ""],
      { timeout: 10_000 }
    );
    return inspected?.stdout.trim() === "true";
  }

  const status = await processManager
    .status(candidate.slug ?? "", candidate.runtime ?? "node")
    .catch(() => ({ running: false }));
  return status.running;
}

/**
 * Per-engine readiness, because "the container is up" and "the database
 * accepts connections" are ten seconds apart, and an application started in
 * that gap crash-loops. It is the single most common reason people conclude
 * that autostart "does not work".
 */
async function waitReady(candidate: Candidate, emit: (line: string) => void): Promise<boolean> {
  const db = await getDb();
  const service = await db
    .selectFrom("services")
    .selectAll()
    .where("id", "=", candidate.id)
    .executeTakeFirst();
  if (!service) return false;

  const target = serviceTarget(service);
  const probe: Record<string, string[]> = {
    postgresql: [...execArgs(target, {}), "pg_isready", "-U", target.credentials.user],
    mysql: [
      ...execArgs(target, { MYSQL_PWD: target.credentials.password }),
      "mysqladmin", "ping", "-u", "root",
    ],
    redis: [...execArgs(target, {}), "redis-cli", "--no-auth-warning", "ping"],
    mongodb: [
      ...execArgs(target, {}),
      "mongosh", "--quiet", "--eval", "db.runCommand({ping:1}).ok",
    ],
  };

  const args = probe[service.type];
  if (!args) return true;

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await dockerTry(args, { timeout: 10_000 });
    if (result) {
      emit(`  ${candidate.name} è pronto`);
      return true;
    }
    await sleep(2000);
  }

  emit(`  ${candidate.name} non ha risposto entro ${READY_TIMEOUT_MS / 1000}s`);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function lastReport(): Promise<ReconcileReport | null> {
  const raw = await getSetting(REPORT_SETTING);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReconcileReport;
  } catch {
    return null;
  }
}

/** Whether this instance would reconcile at all. */
export function reconcilerEnabled(): boolean {
  return !getEnv().disableSchedulers;
}
