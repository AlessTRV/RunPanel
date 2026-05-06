import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { processManager } from "@/services/process-manager";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const db = getDb();
  const project = db.prepare("SELECT id, slug, status, port, runtime_type FROM projects WHERE id = ?")
    .get(projectId) as Record<string, unknown> | undefined;

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let processInfo = null;
  try {
    processInfo = await processManager.status(
      project.slug as string,
      project.runtime_type as string
    );
  } catch { /* ignore */ }

  return NextResponse.json({
    status: project.status,
    port: project.port,
    runtimeType: project.runtime_type,
    process: processInfo,
  });
}
