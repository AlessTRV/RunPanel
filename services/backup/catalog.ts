import { describeCron } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { staleWhileRevalidate } from "@/lib/stale-cache";
import type { BackupRunStatus } from "@/lib/db/schema";
import { readLogFile } from "../log-file";
import { listDumpableDatabases } from "./dumpers";
import { backupLogPath } from "./paths";
import { listProjectVolumes } from "./project-export";
import { parseTargets } from "./scheduler";
import type { BackupTarget } from "./types";

/**
 * The read side: what the pages ask for.
 *
 * It lives next to the engine rather than in the route handlers because three
 * different routes want the same shapes, and because a query that decides what
 * "the last backup" means should have one answer, not one per page.
 */

export interface PolicyView {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  /** The expression in words, so the list never shows raw cron to a human. */
  schedule: string;
  timezone: string | null;
  destinationId: string;
  destinationName: string | null;
  targets: BackupTarget[];
  retentionCount: number | null;
  retentionDays: number | null;
  retentionBytes: number | null;
  includeSecretKey: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: BackupRunStatus | null;
}

export async function listPolicies(): Promise<PolicyView[]> {
  const db = await getDb();

  const [policies, destinations] = await Promise.all([
    db.selectFrom("backup_policies").selectAll().orderBy("created_at", "asc").execute(),
    db.selectFrom("backup_destinations").select(["id", "name"]).execute(),
  ]);

  const names = new Map(destinations.map((d) => [d.id, d.name]));

  // One query for every policy's latest run rather than one per policy: the
  // list is rendered on every poll of the backups page.
  const latest = new Map<string, BackupRunStatus>();
  if (policies.length > 0) {
    const runs = await db
      .selectFrom("backup_runs")
      .select(["policy_id", "status", "started_at"])
      .where(
        "policy_id",
        "in",
        policies.map((p) => p.id)
      )
      .orderBy("started_at", "desc")
      .execute();

    for (const run of runs) {
      if (run.policy_id && !latest.has(run.policy_id)) {
        latest.set(run.policy_id, run.status);
      }
    }
  }

  return policies.map((policy) => ({
    id: policy.id,
    name: policy.name,
    enabled: policy.enabled === 1,
    cron: policy.cron,
    schedule: policy.cron ? describeCron(policy.cron) : "solo su richiesta",
    timezone: policy.timezone,
    destinationId: policy.destination_id,
    destinationName: names.get(policy.destination_id) ?? null,
    targets: parseTargets(policy.targets),
    retentionCount: policy.retention_count,
    retentionDays: policy.retention_days,
    retentionBytes: policy.retention_bytes,
    includeSecretKey: policy.include_secret_key === 1,
    lastRunAt: policy.last_run_at,
    nextRunAt: policy.next_run_at,
    lastStatus: latest.get(policy.id) ?? null,
  }));
}

export interface RunView {
  id: string;
  policyId: string | null;
  policyName: string | null;
  trigger: string;
  status: BackupRunStatus;
  archiveBytes: number | null;
  checksum: string | null;
  pinned: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** Null while the run is still going. */
  durationMs: number | null;
  hasArchive: boolean;
  errorMessage: string | null;
}

export async function listRuns(limit = 50, policyId?: string): Promise<RunView[]> {
  const db = await getDb();

  let query = db.selectFrom("backup_runs").selectAll().orderBy("started_at", "desc").limit(limit);
  if (policyId) query = query.where("policy_id", "=", policyId);

  const runs = await query.execute();
  return runs.map(toRunView);
}

function toRunView(run: {
  id: string;
  policy_id: string | null;
  policy_name: string | null;
  trigger: string;
  status: BackupRunStatus;
  archive_bytes: number | null;
  archive_path: string | null;
  checksum: string | null;
  pinned: number;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
}): RunView {
  return {
    id: run.id,
    policyId: run.policy_id,
    policyName: run.policy_name,
    trigger: run.trigger,
    status: run.status,
    archiveBytes: run.archive_bytes,
    checksum: run.checksum,
    pinned: run.pinned === 1,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    durationMs: run.finished_at ? Date.parse(run.finished_at) - Date.parse(run.started_at) : null,
    hasArchive: Boolean(run.archive_path),
    errorMessage: run.error_message,
  };
}

export interface RunDetail extends RunView {
  artifacts: {
    id: string;
    kind: string;
    refId: string | null;
    refName: string;
    entryPath: string;
    bytes: number;
    checksum: string | null;
    status: string;
    errorMessage: string | null;
    meta: unknown;
  }[];
  log: string;
}

export async function getRunDetail(runId: string): Promise<RunDetail | null> {
  const db = await getDb();
  const run = await db
    .selectFrom("backup_runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst();

  if (!run) return null;

  const artifacts = await db
    .selectFrom("backup_artifacts")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("created_at", "asc")
    .execute();

  return {
    ...toRunView(run),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      refId: artifact.ref_id,
      refName: artifact.ref_name,
      entryPath: artifact.entry_path,
      bytes: artifact.bytes,
      checksum: artifact.checksum,
      status: artifact.status,
      errorMessage: artifact.error_message,
      meta: artifact.meta ? safeJson(artifact.meta) : null,
    })),
    log: readLogFile(backupLogPath(runId)),
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface BackupOverview {
  lastRun: RunView | null;
  nextRunAt: string | null;
  totalBytes: number;
  runCount: number;
  /** Over the last seven days, so a run of failures is visible at a glance. */
  recent: { ok: number; failed: number };
  policiesEnabled: number;
}

export async function backupOverview(): Promise<BackupOverview> {
  const db = await getDb();

  const [runs, policies] = await Promise.all([
    db
      .selectFrom("backup_runs")
      .selectAll()
      .orderBy("started_at", "desc")
      .limit(200)
      .execute(),
    db.selectFrom("backup_policies").selectAll().execute(),
  ]);

  const weekAgo = Date.now() - 7 * 86_400_000;
  const recent = runs.filter((run) => Date.parse(run.started_at) >= weekAgo);

  const upcoming = policies
    .filter((policy) => policy.enabled === 1 && policy.next_run_at)
    .map((policy) => policy.next_run_at as string)
    .sort();

  return {
    lastRun: runs[0] ? toRunView(runs[0]) : null,
    nextRunAt: upcoming[0] ?? null,
    totalBytes: runs.reduce((total, run) => total + (run.archive_bytes ?? 0), 0),
    runCount: runs.length,
    recent: {
      ok: recent.filter((run) => run.status === "success" || run.status === "partial").length,
      failed: recent.filter((run) => run.status === "failed").length,
    },
    policiesEnabled: policies.filter((policy) => policy.enabled === 1).length,
  };
}

export interface TargetCatalog {
  services: { id: string; name: string; type: string; version: string; databases: string[] }[];
  projects: { id: string; slug: string; name: string; sourceType: string; volumes: string[] }[];
}

/**
 * What a policy can be pointed at. The database and volume lists come from the
 * engines and from Docker's labels, not from our own rows, so the editor offers
 * what actually exists.
 */
/**
 * Cached view of `listTargets`, for the endpoint the policy editor polls.
 *
 * Building it runs a `docker exec` per database service and a `docker volume
 * ls` per project, and the backups page asks for it at the same moment the
 * policy form does — two identical answers computed side by side. Short TTL,
 * because the whole point of the list is that it reflects what exists now.
 */
export const targetsCache = staleWhileRevalidate(() => listTargets(), 15_000);

export async function listTargets(): Promise<TargetCatalog> {
  const db = await getDb();
  const [services, projects] = await Promise.all([
    db.selectFrom("services").selectAll().orderBy("name", "asc").execute(),
    db.selectFrom("projects").selectAll().orderBy("name", "asc").execute(),
  ]);

  const withDatabases = await Promise.all(
    services.map(async (service) => ({
      id: service.id,
      name: service.name,
      type: service.type,
      version: service.version,
      // A stopped or unreachable engine simply offers nothing rather than
      // failing the whole catalogue.
      databases: await listDumpableDatabases(service).catch(() => []),
    }))
  );

  const withVolumes = await Promise.all(
    projects.map(async (project) => ({
      id: project.id,
      slug: project.slug,
      name: project.name,
      sourceType: project.source_type,
      volumes: await listProjectVolumes(project.slug).catch(() => []),
    }))
  );

  return { services: withDatabases, projects: withVolumes };
}
