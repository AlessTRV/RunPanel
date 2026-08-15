import { getDb, nowIso, rowCount } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { executeDeploy } from "./deploy-pipeline";

/**
 * Serialises deploys per project, and remembers one follow-up.
 *
 * Two deploys of the same project must never overlap — they fight over the same
 * checkout, the same container name and the same port. The conditional claim
 * guarantees that, but on its own it just rejects the second request, which for
 * a webhook means a push is silently dropped: someone pushes a fix while a
 * deploy is running and nothing ever builds it.
 *
 * So a request that arrives during a deploy is *coalesced* instead. At most one
 * follow-up is remembered, because the follow-up always pulls the latest commit
 * — queueing five pushes would just build the same head five times.
 */

type Trigger = "manual" | "webhook" | "poll";

interface QueuedRequest {
  mode: "deploy" | "rebuild";
  trigger: Trigger;
  commitSha: string | null;
  commitMessage: string | null;
}

export interface EnqueueResult {
  status: "started" | "queued" | "not-found";
  deploymentId?: string;
}

const pending = new Map<string, QueuedRequest>();

async function claim(projectId: string): Promise<ProjectsTable | null | "busy"> {
  const db = await getDb();

  const before = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!before) return null;

  const claimed = await db
    .updateTable("projects")
    .set({ status: "deploying", updated_at: nowIso() })
    .where("id", "=", projectId)
    .where("status", "!=", "deploying")
    .executeTakeFirst();

  return rowCount(claimed) === 0 ? "busy" : before;
}

async function createDeploymentRow(
  projectId: string,
  request: QueuedRequest
): Promise<string> {
  const db = await getDb();
  const deploymentId = generateId();

  await db
    .insertInto("deployments")
    .values({
      id: deploymentId,
      project_id: projectId,
      trigger_type: request.trigger,
      commit_sha: request.commitSha,
      commit_message: request.commitMessage,
      status: "pending",
      started_at: nowIso(),
      finished_at: null,
      error_message: null,
      start_cmd: null,
      artifact_dir: null,
    })
    .execute();

  return deploymentId;
}

async function run(project: ProjectsTable, request: QueuedRequest): Promise<void> {
  const deploymentId = await createDeploymentRow(project.id, request);
  await executeDeploy(project, deploymentId, { mode: request.mode });

  const next = pending.get(project.id);
  if (!next) return;
  pending.delete(project.id);

  // Re-read: the queued run must see the project as it is now, including the
  // status the run that just finished left behind.
  const fresh = await claim(project.id);
  if (fresh === "busy" || fresh === null) return;

  void run(fresh, next).catch((err) => {
    console.error(`[deploy-queue] Queued deploy failed for ${project.slug}:`, err);
  });
}

export async function enqueueDeploy(
  projectId: string,
  request: QueuedRequest
): Promise<EnqueueResult> {
  const claimed = await claim(projectId);
  if (claimed === null) return { status: "not-found" };

  if (claimed === "busy") {
    // Replace rather than append: the follow-up will fetch the latest commit
    // anyway, so remembering more than one would rebuild the same head twice.
    pending.set(projectId, request);
    return { status: "queued" };
  }

  const deploymentId = await createDeploymentRow(projectId, request);

  void executeDeploy(claimed, deploymentId, { mode: request.mode })
    .then(async () => {
      const next = pending.get(projectId);
      if (!next) return;
      pending.delete(projectId);

      const fresh = await claim(projectId);
      if (fresh === "busy" || fresh === null) return;
      await run(fresh, next);
    })
    .catch((err) => {
      console.error(`[deploy-queue] Deploy failed for ${projectId}:`, err);
    });

  return { status: "started", deploymentId };
}


/** Forget a project's queued run, e.g. when it is deleted mid-deploy. */
export function clearQueuedDeploy(projectId: string): void {
  pending.delete(projectId);
}
