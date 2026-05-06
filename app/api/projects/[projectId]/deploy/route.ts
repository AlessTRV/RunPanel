import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { executeDeploy } from "@/services/deploy-pipeline";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;

  // Parse optional body for mode
  let mode: "deploy" | "rebuild" = "deploy";
  try {
    const body = await request.json();
    if (body.mode === "rebuild") mode = "rebuild";
  } catch { /* no body or invalid JSON — default to deploy */ }

  const db = getDb();
  const deploymentId = generateId();

  // Atomic check + insert to prevent race conditions
  const result = db.transaction(() => {
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;

    if (!project) return { error: "Project not found", status: 404 };
    if (project.status === "deploying") return { error: "Deployment already in progress", status: 409 };

    db.prepare(`
      INSERT INTO deployments (id, project_id, trigger_type, status)
      VALUES (?, ?, 'manual', 'pending')
    `).run(deploymentId, projectId);

    db.prepare("UPDATE projects SET status = 'deploying', updated_at = datetime('now') WHERE id = ?")
      .run(projectId);

    return { project };
  })();

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // Fire and forget - deploy runs in background
  executeDeploy(result.project as unknown as Parameters<typeof executeDeploy>[0], deploymentId, { mode }).catch(() => {});

  return NextResponse.json({
    deploymentId,
    status: "pending",
    mode,
    message: mode === "rebuild" ? "Re-build started" : "Deployment started",
  }, { status: 202 });
}
