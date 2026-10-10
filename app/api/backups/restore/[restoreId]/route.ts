import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { restoreVisible } from "@/lib/backup-access";
import { getDb } from "@/lib/db";
import { assertBackupId, restoreLogPath } from "@/services/backup/paths";
import { readLogFile } from "@/services/log-file";

type Params = { params: Promise<{ restoreId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requirePermission("restore");
  if (isDenied(denied)) return denied;

  const { restoreId } = await params;

  if (!(await restoreVisible(denied.principal, restoreId))) return NextResponse.json({ error: "Ripristino non trovato" }, { status: 404 });
  try {
    assertBackupId(restoreId);
  } catch {
    return NextResponse.json({ error: "Ripristino non trovato" }, { status: 404 });
  }

  const db = await getDb();
  const restore = await db
    .selectFrom("restore_runs")
    .selectAll()
    .where("id", "=", restoreId)
    .executeTakeFirst();

  if (!restore) return NextResponse.json({ error: "Ripristino non trovato" }, { status: 404 });

  return NextResponse.json({
    id: restore.id,
    runId: restore.run_id,
    source: restore.source,
    status: restore.status,
    safetyRunId: restore.safety_run_id,
    errorMessage: restore.error_message,
    startedAt: restore.started_at,
    finishedAt: restore.finished_at,
    durationMs: restore.finished_at
      ? Date.parse(restore.finished_at) - Date.parse(restore.started_at)
      : null,
    log: readLogFile(restoreLogPath(restoreId)),
  });
}
