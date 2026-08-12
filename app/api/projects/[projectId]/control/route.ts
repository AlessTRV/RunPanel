import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { controlActionSchema } from "@/lib/validation";
import { processManager } from "@/services/process-manager";
import { projectEvents } from "@/services/events";
import { decrypt } from "@/lib/crypto";

type Params = { params: Promise<{ projectId: string }> };

/** Replay the last successful deployment's start command. */
async function startFromDeploy(
  projectId: string,
  slug: string,
  runtimeType: string,
  projectPort: number | null
) {
  const db = await getDb();

  const lastDeploy = await db
    .selectFrom("deployments")
    .select(["start_cmd", "artifact_dir"])
    .where("project_id", "=", projectId)
    .where("status", "in", ["running", "superseded"])
    .where("start_cmd", "is not", null)
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();

  if (!lastDeploy?.start_cmd || !lastDeploy.artifact_dir) {
    return { error: "Non c'è nessun deploy riuscito da riavviare. Fai prima un deploy." };
  }

  const envRows = await db
    .selectFrom("env_vars")
    .select(["key", "value"])
    .where("project_id", "=", projectId)
    .execute();

  const envVars: Record<string, string> = {};
  for (const row of envRows) {
    envVars[row.key] = decrypt(row.value);
  }

  const port = projectPort ?? 3000;

  // The driver empties the process output before launching, so tell any open
  // viewer to do the same rather than leave it showing the previous run.
  projectEvents.emit(projectId, { type: "process:reset" });

  await processManager.start(slug, lastDeploy.start_cmd, runtimeType, {
    cwd: lastDeploy.artifact_dir,
    env: envVars,
    port,
  });

  await db
    .updateTable("projects")
    .set({ status: "running", updated_at: nowIso() })
    .where("id", "=", projectId)
    .execute();

  return { success: true as const };
}

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
        const result = await startFromDeploy(projectId, slug, runtimeType, project.port);
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
