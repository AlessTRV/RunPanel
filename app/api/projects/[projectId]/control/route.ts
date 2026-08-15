import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { controlActionSchema } from "@/lib/validation";
import { processManager } from "@/services/process-manager";
import { restartFromLastDeployment } from "@/services/project-restart";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  // A malformed body is a bad request, not a 500.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = controlActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Azione non valida" }, { status: 400 });
  }

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  const { action } = parsed.data;
  const { slug, runtime_type: runtimeType } = project;

  try {
    switch (action) {
      case "start":
      case "restart": {
        // Shared with the access change, which needs the same operation. It
        // also replays the deploy contract, which the copy that used to live
        // here did not: restarting a project used to quietly move it off
        // `network: host`, drop its bind mounts and reset its restart policy.
        const result = await restartFromLastDeployment(projectId);
        if ("error" in result) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        break;
      }
      case "stop":
        await processManager.stop(slug, runtimeType);
        await db
          .updateTable("projects")
          .set({ status: "stopped", updated_at: nowIso() })
          .where("id", "=", projectId)
          .execute();
        break;
    }

    return NextResponse.json({ success: true, action });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : `${action} failed`;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
