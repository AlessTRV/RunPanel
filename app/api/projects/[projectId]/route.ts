import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { updateProjectSchema } from "@/lib/validation";
import fs from "fs";
import path from "path";
import { config } from "@/lib/config";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const db = getDb();
  const project = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM deployments WHERE project_id = p.id) as deploy_count,
      (SELECT started_at FROM deployments WHERE project_id = p.id ORDER BY started_at DESC LIMIT 1) as last_deploy_at
    FROM projects p WHERE p.id = ?
  `).get(projectId);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json(project);
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const body = await request.json();
  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const db = getDb();
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  const { name, sourceBranch, runtimeType, port, autoDeploy, builderConfig } = parsed.data;

  if (name !== undefined) { updates.push("name = ?"); values.push(name); }
  if (sourceBranch !== undefined) { updates.push("source_branch = ?"); values.push(sourceBranch); }
  if (runtimeType !== undefined) { updates.push("runtime_type = ?"); values.push(runtimeType); }
  if (port !== undefined) { updates.push("port = ?"); values.push(port); }
  if (autoDeploy !== undefined) { updates.push("auto_deploy = ?"); values.push(autoDeploy ? 1 : 0); }
  if (builderConfig !== undefined) { updates.push("builder_config = ?"); values.push(JSON.stringify(builderConfig)); }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    values.push(projectId);
    db.prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  return NextResponse.json(updated);
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const db = getDb();
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Delete project files
  const repoDir = path.join(config.reposDir, project.slug as string);
  if (fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  // DB cascade handles deployments, env_vars, webhook_deliveries
  db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);

  return NextResponse.json({ success: true });
}
