import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { requireHostIfReaching } from "@/lib/host-guard";
import { withAudit } from "@/lib/audit";
import { parseBackupSettings } from "@/lib/backup-settings";
import { getDb, nowIso, rowCount } from "@/lib/db";
import { projectBackupSettingsSchema } from "@/lib/validation";
import { projectBackupView } from "@/services/backup/catalog";

type Params = { params: Promise<{ projectId: string }> };

/**
 * How this project's volumes are backed up, and what there is to back up.
 *
 * Its own route rather than a field of `GET /api/projects/:id`: answering it
 * asks Docker about every volume and every container that mounts one, and the
 * project page polls its row far too often for that.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "view");
  if (isDenied(denied)) return denied;
  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

  return NextResponse.json(await projectBackupView(project));
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.backup", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "backup");
    if (isDenied(denied)) return denied;
    const noHost = await requireHostIfReaching(denied.principal, projectId, "impostare comandi di backup su un progetto che raggiunge l'host");
    if (noHost) return noHost;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }

    const parsed = projectBackupSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }

    // Stored in the form the backup reads — through the same parser — so
    // `trades` and `./trades/` typed on two lines are one exclusion on disk too,
    // and what the page shows after saving is what the next run will do.
    const settings = parseBackupSettings(JSON.stringify(parsed.data));

    const db = await getDb();
    const result = await db
      .updateTable("projects")
      .set({ backup_settings: JSON.stringify(settings), updated_at: nowIso() })
      .where("id", "=", projectId)
      .executeTakeFirst();

    if (rowCount(result) === 0) {
      return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
    }

    return NextResponse.json({ settings });
  });
}
