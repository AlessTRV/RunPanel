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
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let processInfo = null;
  try {
    processInfo = await processManager.status(project.slug, project.runtime_type);
  } catch { /* ignore */ }

  return NextResponse.json({
    status: project.status,
    port: project.port,
    runtimeType: project.runtime_type,
    process: processInfo,
  });
}
