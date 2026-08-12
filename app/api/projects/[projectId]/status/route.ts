import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { processManager } from "@/services/process-manager";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["id", "slug", "status", "port", "runtime_type"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  // Asking the driver about a project that is not up costs a pm2/docker spawn to
  // be told what the row already says. This endpoint is polled every 5 seconds
  // per open project page, so it was the single most expensive thing the panel
  // did while idle. /api/monitor has always guarded this; here it did not.
  let processInfo = null;
  if (project.status === "running" || project.status === "deploying") {
    try {
      processInfo = await processManager.status(project.slug, project.runtime_type);
    } catch { /* a driver that cannot answer is reported as no process info */ }
  }

  return NextResponse.json({
    status: project.status,
    port: project.port,
    runtimeType: project.runtime_type,
    process: processInfo,
  });
}
