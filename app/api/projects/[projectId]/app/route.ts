import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { processManager } from "@/services/process-manager";
import { config } from "@/lib/config";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const exec = promisify(execFile);

type Params = { params: Promise<{ projectId: string }> };

// DELETE: Remove app from project (stop process, clean Docker, clean files, reset config)
export async function DELETE(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const db = getDb();
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const slug = project.slug as string;
  const runtimeType = project.runtime_type as string;

  // 1. Stop running process (PM2 delete or Docker rm)
  try {
    await processManager.stop(slug, runtimeType);
  } catch { /* ignore */ }

  // 2. Remove Docker image if docker runtime
  if (runtimeType === "docker") {
    try { await exec("docker", ["rmi", "-f", `runpanel-${slug}`], { timeout: 15_000 }); } catch { /* ignore */ }
  }

  // 3. Delete source files
  const repoDir = path.join(config.reposDir, slug);
  if (fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  // 4. Delete PM2 wrapper files
  const pm2Dir = path.join(config.dataDir, "pm2");
  for (const ext of [".js", ".json", ".cmd", ".sh"]) {
    const f = path.join(pm2Dir, `${slug}${ext}`);
    if (fs.existsSync(f)) fs.rmSync(f);
  }

  // 5. Reset project app config (keep project + services)
  db.prepare(`
    UPDATE projects SET
      source_type = 'upload', source_url = NULL, source_branch = 'main',
      runtime_type = 'node', builder_config = '{}', port = NULL,
      app_name = NULL, status = 'stopped', updated_at = datetime('now')
    WHERE id = ?
  `).run(projectId);

  // 6. Delete deployments for this project
  db.prepare("DELETE FROM deployments WHERE project_id = ?").run(projectId);

  return NextResponse.json({ success: true });
}
