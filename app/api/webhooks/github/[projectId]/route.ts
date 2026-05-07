import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { verifyWebhookSignature } from "@/services/git-manager";
import { executeDeploy } from "@/services/deploy-pipeline";
import type { GitHubPushPayload } from "@/lib/types";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const db = getDb();
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Verify signature — limit payload size to 1MB
  const signature = request.headers.get("x-hub-signature-256") || "";
  const contentLength = parseInt(request.headers.get("content-length") || "0");
  if (contentLength > 1024 * 1024) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const body = await request.text();
  if (body.length > 1024 * 1024) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  if (!verifyWebhookSignature(Buffer.from(body), signature, project.webhook_secret as string)) {
    db.prepare(`
      INSERT INTO webhook_deliveries (id, project_id, status, payload_summary)
      VALUES (?, ?, 'rejected', ?)
    `).run(generateId(), projectId, JSON.stringify({ reason: "invalid signature" }));

    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: GitHubPushPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const event = request.headers.get("x-github-event");

  // Only handle push events
  if (event !== "push") {
    db.prepare(`
      INSERT INTO webhook_deliveries (id, project_id, status, payload_summary)
      VALUES (?, ?, 'ignored', ?)
    `).run(generateId(), projectId, JSON.stringify({ event, reason: "not a push event" }));

    return NextResponse.json({ message: "Event ignored" });
  }

  // Check if auto-deploy is enabled
  if (!project.auto_deploy) {
    db.prepare(`
      INSERT INTO webhook_deliveries (id, project_id, status, payload_summary)
      VALUES (?, ?, 'ignored', ?)
    `).run(generateId(), projectId, JSON.stringify({ event, reason: "auto_deploy disabled" }));

    return NextResponse.json({ message: "Auto-deploy disabled" });
  }

  // Check branch matches — sanitize to prevent injection
  const ref = typeof payload.ref === "string" ? payload.ref : "";
  const pushBranch = ref.replace("refs/heads/", "").replace(/[^a-zA-Z0-9._/-]/g, "");
  if (pushBranch !== project.source_branch) {
    db.prepare(`
      INSERT INTO webhook_deliveries (id, project_id, status, payload_summary)
      VALUES (?, ?, 'ignored', ?)
    `).run(generateId(), projectId, JSON.stringify({ event, branch: pushBranch, reason: "branch mismatch" }));

    return NextResponse.json({ message: "Branch mismatch" });
  }

  // Trigger deploy
  const deploymentId = generateId();
  db.prepare(`
    INSERT INTO deployments (id, project_id, trigger_type, status, commit_sha, commit_message)
    VALUES (?, ?, 'webhook', 'pending', ?, ?)
  `).run(
    deploymentId,
    projectId,
    payload.head_commit?.id || null,
    payload.head_commit?.message || null
  );

  db.prepare(`
    INSERT INTO webhook_deliveries (id, project_id, status, deployment_id, payload_summary)
    VALUES (?, ?, 'accepted', ?, ?)
  `).run(
    generateId(),
    projectId,
    deploymentId,
    JSON.stringify({ event, sender: payload.sender?.login, ref, head_commit: payload.head_commit?.id?.slice(0, 7) })
  );

  db.prepare("UPDATE projects SET status = 'deploying', updated_at = datetime('now') WHERE id = ?")
    .run(projectId);

  // Fire and forget
  executeDeploy(project as unknown as Parameters<typeof executeDeploy>[0], deploymentId).catch(() => {});

  return NextResponse.json({ message: "Deploy triggered", deploymentId });
}
