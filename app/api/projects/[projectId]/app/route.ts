import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { processManager } from "@/services/process-manager";
import { removeProjectImages } from "@/services/docker/images";
import { removePm2Artifacts } from "@/services/process-drivers/pm2-driver";
import { removeEnvFile } from "@/services/env-file";
import { config } from "@/lib/config";
import fs from "fs";
import path from "path";

type Params = { params: Promise<{ projectId: string }> };

// DELETE: Remove app from project (stop process, clean Docker, clean files, reset config)
export async function DELETE(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { slug, runtime_type: runtimeType } = project;

  // 1. Stop running process (PM2 delete or Docker rm)
  try {
    await processManager.remove(slug, runtimeType);
  } catch { /* ignore */ }

  // 2. Remove every image RunPanel built for this app. Each deploy produced its
  // own immutable tag, so removing a single name would leave the rest behind.
  await removeProjectImages(slug);

  // 3. Delete source files
  const repoDir = path.join(config.reposDir, slug);
  if (fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  // 4. Delete generated PM2 files, including the sidecar with the environment
  removePm2Artifacts(slug);
  removeEnvFile(slug);

  // 5. Reset project app config (keep project + services)
  await db
    .updateTable("projects")
    .set({
      source_type: "upload",
      source_url: null,
      source_branch: "main",
      runtime_type: "node",
      builder_config: "{}",
      port: null,
      app_name: null,
      status: "stopped",
      updated_at: nowIso(),
    })
    .where("id", "=", projectId)
    .execute();

  // 6. Drop deployment history. `webhook_deliveries.deployment_id` is
  // ON DELETE SET NULL, so the delivery records survive with a null link.
  await db.deleteFrom("deployments").where("project_id", "=", projectId).execute();

  return NextResponse.json({ success: true });
}
