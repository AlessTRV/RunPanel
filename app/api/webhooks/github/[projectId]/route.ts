/**
 * The one route whose error strings stay in English.
 *
 * Everything else the panel says is Italian, because an operator reads it.
 * These are read by GitHub — they land in the repository's "Recent Deliveries"
 * list, next to GitHub's own English UI, and whoever debugs a rejected webhook
 * is reading them there rather than here.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb, nowIso } from "@/lib/db";
import type { WebhookStatus } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { consumeRateLimit } from "@/lib/rate-limit";
import { verifyWebhookSignature } from "@/services/git-manager";
import { enqueueDeploy } from "@/services/deploy-queue";
import type { GitHubPushPayload } from "@/lib/types";

type Params = { params: Promise<{ projectId: string }> };

const MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * How many refused deliveries a project may write per hour.
 *
 * Refusals used to be dropped entirely, and the reasoning was sound: this
 * endpoint is public, so recording before the signature is checked is an
 * unauthenticated INSERT that anyone holding a project id can repeat until the
 * disk is full. But the cost of dropping them is that the single most common
 * setup mistake — a secret typed wrong, or not typed at all — produces no
 * evidence anywhere in the panel, which is most of why auto-deploy "just
 * doesn't work" with nothing to look at.
 *
 * A handful an hour is enough for the evidence and not enough for the attack;
 * the rest stay a log line. The limiter is the DB-backed one, so this survives a
 * restart along with everything else.
 */
const REJECTED_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

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

  /** A refusal, recorded only while this project is under its hourly budget. */
  async function recordRejection(summary: Record<string, unknown>) {
    const { allowed } = await consumeRateLimit(
      `webhook-rejected:${projectId}`,
      REJECTED_PER_HOUR,
      HOUR_MS
    );
    if (allowed) await recordDelivery("rejected", summary);
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
    console.warn(`[webhook] Rejected delivery for project ${projectId}: invalid signature`);
    await recordRejection({
      event: request.headers.get("x-github-event"),
      reason: signature ? "invalid signature" : "no signature — the webhook has no secret set",
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");

  /*
    Both content types GitHub can send, because it sends whichever one the
    webhook was configured with and the choice is a dropdown in its form.

    `application/x-www-form-urlencoded` used to pass the signature — the HMAC is
    over the raw body either way — and then die in `JSON.parse` as a bare
    400 "Invalid JSON", which reads like a bug in the sender. It is a body with
    the payload in a `payload` field, so it is read as one.
  */
  const contentType = request.headers.get("content-type") ?? "";
  const formEncoded = contentType.includes("application/x-www-form-urlencoded");

  let payload: GitHubPushPayload;
  try {
    payload = JSON.parse(formEncoded ? (new URLSearchParams(body).get("payload") ?? "") : body);
  } catch {
    await recordRejection({ event, reason: "unreadable body", contentType });
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  /*
    The ping, answered as what it is.

    GitHub sends one the moment a webhook is created, and its own docs call it
    the confirmation that the hook is set up correctly. Filed under "not a push
    event" it was the only feedback the operator got, and it read as a refusal —
    so the one delivery designed to say "this works" was the one saying the
    least.
  */
  if (event === "ping") {
    await recordDelivery("accepted", { event, contentType, formEncoded });
    return NextResponse.json({ message: "Pong — RunPanel received this webhook" });
  }

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
    await recordDelivery("ignored", {
      event,
      branch: pushBranch,
      expected: project.source_branch,
      reason: "branch mismatch",
    });
    return NextResponse.json({ message: "Branch mismatch" });
  }

  /*
    A pinned project is held at a commit on purpose, so a push does not move it.

    After the branch check, not before: reported earlier, every push to an
    unrelated branch would be filed as "pinned", and the reason would stop
    meaning anything. Here it appears on exactly the deliveries that would
    otherwise have deployed — which is the case the operator is looking for when
    they wonder why a push changed nothing.

    Recorded as `ignored` rather than `rejected`: the signature was valid and the
    payload was understood — it is the panel that chose not to act, and that is
    the distinction this table exists to make (`rejected` is reserved for bad
    signatures and is what the rate limiter counts).
  */
  if (project.pinned_sha) {
    await recordDelivery("ignored", {
      event,
      branch: pushBranch,
      reason: "project pinned to a commit",
      pinned: project.pinned_sha.slice(0, 7),
    });
    return NextResponse.json({ message: "Project pinned to a commit" });
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
