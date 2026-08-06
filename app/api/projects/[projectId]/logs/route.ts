import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { processManager } from "@/services/process-manager";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const db = await getDb();

  const source = request.nextUrl.searchParams.get("source");

  // Process logs (PM2/Docker live output)
  if (source === "process") {
    const project = await db
      .selectFrom("projects")
      .select(["slug", "runtime_type"])
      .where("id", "=", projectId)
      .executeTakeFirst();

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
  const deployments = await db
    .selectFrom("deployments")
    .select([
      "id",
      "trigger_type",
      "commit_sha",
      "commit_message",
      "status",
      "started_at",
      "finished_at",
      "error_message",
    ])
    .where("project_id", "=", projectId)
    .orderBy("started_at", "desc")
    .limit(50)
    .execute();

  return NextResponse.json(deployments);
}
