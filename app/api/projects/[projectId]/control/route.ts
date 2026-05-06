import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { controlActionSchema } from "@/lib/validation";
import { processManager } from "@/services/process-manager";
import { decrypt } from "@/lib/auth";

type Params = { params: Promise<{ projectId: string }> };

/** Load last deployment info and env vars, then start via processManager */
async function startFromDeploy(
  projectId: string,
  slug: string,
  runtimeType: string,
  projectPort: number | null
) {
  const db = getDb();

  const lastDeploy = db.prepare(`
    SELECT start_cmd, artifact_dir FROM deployments
    WHERE project_id = ? AND status IN ('running', 'superseded') AND start_cmd IS NOT NULL
    ORDER BY started_at DESC LIMIT 1
  `).get(projectId) as { start_cmd: string; artifact_dir: string } | undefined;

  if (!lastDeploy) {
    return { error: "No previous successful deployment found. Deploy the project first." };
  }

  // Load and decrypt env vars
  const envRows = db.prepare(
    "SELECT key, value FROM env_vars WHERE project_id = ?"
  ).all(projectId) as { key: string; value: string }[];

  const envVars: Record<string, string> = {};
  for (const row of envRows) {
    envVars[row.key] = decrypt(row.value);
  }

  const port = projectPort || 3000;

  await processManager.start(slug, lastDeploy.start_cmd, runtimeType, {
    cwd: lastDeploy.artifact_dir,
    env: envVars,
    port,
  });

  db.prepare("UPDATE projects SET status = 'running', updated_at = datetime('now') WHERE id = ?")
    .run(projectId);

  return { success: true };
}

export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const body = await request.json();
  const parsed = controlActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const db = getDb();
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { action } = parsed.data;
  const slug = project.slug as string;
  const runtimeType = project.runtime_type as string;

  try {
    switch (action) {
      case "start":
      case "restart": {
        const result = await startFromDeploy(
          projectId, slug, runtimeType, project.port as number | null
        );
        if ("error" in result) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
        break;
      }
      case "stop":
        await processManager.stop(slug, runtimeType);
        db.prepare("UPDATE projects SET status = 'stopped', updated_at = datetime('now') WHERE id = ?").run(projectId);
        break;
    }

    return NextResponse.json({ success: true, action });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : `${action} failed`;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
