import { NextRequest, NextResponse } from "next/server";
import { getDb, nowIso } from "@/lib/db";
import type { WebhookStatus } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { verifyWebhookSignature } from "@/services/git-manager";
import { enqueueDeploy } from "@/services/deploy-queue";
import type { GitHubPushPayload } from "@/lib/types";

type Params = { params: Promise<{ projectId: string }> };

const MAX_PAYLOAD_BYTES = 1024 * 1024;

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const db = await getDb();

  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  // Answered the same way as a bad signature, deliberately. Distinguishing the
  // two told an unauthenticated caller which project ids exist.
  if (!project) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  async function recordDelivery(
    status: WebhookStatus,
    summary: Record<string, unknown>,
    deploymentId: string | null = null
  ) {
    await db
      .insertInto("webhook_deliveries")
      .values({
        id: generateId(),
        project_id: projectId,
        status,
        deployment_id: deploymentId,
        payload_summary: JSON.stringify(summary),
        received_at: nowIso(),
      })
      .execute();
  }

  // Verify signature — cap payload size first
  const signature = request.headers.get("x-hub-signature-256") || "";
  const contentLength = Number.parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return NextResponse.json({ error: "File troppo grande" }, { status: 413 });
  }
  const body = await request.text();
  if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
    return NextResponse.json({ error: "File troppo grande" }, { status: 413 });
  }

  if (!verifyWebhookSignature(Buffer.from(body), signature, project.webhook_secret)) {
    // Not recorded. This endpoint has to stay public, so a row written before
    // the signature was checked was an unauthenticated INSERT that anyone
    // holding a project id could repeat until the disk filled. The log line
    // keeps the signal without the storage.
    console.warn(`[webhook] Rejected delivery for project ${projectId}: invalid signature`);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: GitHubPushPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const event = request.headers.get("x-github-event");

  if (event !== "push") {
    await recordDelivery("ignored", { event, reason: "not a push event" });
    return NextResponse.json({ message: "Event ignored" });
  }

  if (!project.auto_deploy) {
    await recordDelivery("ignored", { event, reason: "auto_deploy disabled" });
    return NextResponse.json({ message: "Auto-deploy disabled" });
  }

  // Check branch matches — sanitize to prevent injection
  const ref = typeof payload.ref === "string" ? payload.ref : "";
  const pushBranch = ref.replace("refs/heads/", "").replace(/[^a-zA-Z0-9._/-]/g, "");
  if (pushBranch !== project.source_branch) {
    await recordDelivery("ignored", { event, branch: pushBranch, reason: "branch mismatch" });
    return NextResponse.json({ message: "Branch mismatch" });
  }

  // Queued rather than refused. Rejecting a push that arrives during a deploy
  // silently drops it — someone pushes a fix while a build is running and
  // nothing ever picks it up.
  const result = await enqueueDeploy(projectId, {
    mode: "deploy",
    trigger: "webhook",
    commitSha: payload.head_commit?.id ?? null,
    commitMessage: payload.head_commit?.message ?? null,
  });

  const summary = {
    event,
    sender: payload.sender?.login,
    ref,
    head_commit: payload.head_commit?.id?.slice(0, 7),
  };

  if (result.status === "not-found") {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  if (result.status === "queued") {
    await recordDelivery("accepted", { ...summary, queued: true });
    return NextResponse.json({ message: "Deploy queued behind the running one" });
  }

  await recordDelivery("accepted", summary, result.deploymentId ?? null);
  return NextResponse.json({ message: "Deploy triggered", deploymentId: result.deploymentId });
}
