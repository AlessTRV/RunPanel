import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { processManager } from "@/services/process-manager";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const db = getDb();

  const source = request.nextUrl.searchParams.get("source");

  // Process logs (PM2/Docker live output)
  if (source === "process") {
    const project = db.prepare("SELECT slug, runtime_type FROM projects WHERE id = ?")
      .get(projectId) as { slug: string; runtime_type: string } | undefined;

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    try {
      const logs = await processManager.logs(project.slug, project.runtime_type, 100);
      return NextResponse.json({ logs });
    } catch {
      return NextResponse.json({ logs: [] });
    }
  }

  // Default: deployment history
  const deployments = db.prepare(`
    SELECT id, trigger_type, commit_sha, commit_message, status, started_at, finished_at, error_message
    FROM deployments WHERE project_id = ?
    ORDER BY started_at DESC LIMIT 50
  `).all(projectId);

  return NextResponse.json(deployments);
}
