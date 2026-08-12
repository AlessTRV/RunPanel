import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { getRunDetail } from "@/services/backup/catalog";
import { buildDestination } from "@/services/backup/destinations";
import { assertBackupId, backupLogPath } from "@/services/backup/paths";
import { removeLogFile } from "@/services/log-file";

type Params = { params: Promise<{ runId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { runId } = await params;
  // Shape-checked before it is used anywhere, including as a log path.
  try {
    assertBackupId(runId);
  } catch {
    return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });
  }

  const detail = await getRunDetail(runId);
  if (!detail) return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });

  return NextResponse.json(detail);
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { runId } = await params;
  try {
    assertBackupId(runId);
  } catch {
    return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });
  }

  const db = await getDb();
  const run = await db
    .selectFrom("backup_runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst();

  if (!run) return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });
  if (run.status === "running") {
    return NextResponse.json(
      { error: "Il backup è ancora in corso: attendi che finisca" },
      { status: 409 }
    );
  }

  // The archive first: a row removed while its file survives leaves something
  // on disk that nothing knows about or will ever clean up.
  if (run.archive_path && run.destination_id) {
    const destination = await db
      .selectFrom("backup_destinations")
      .selectAll()
      .where("id", "=", run.destination_id)
      .executeTakeFirst();

    if (destination) {
      try {
        await buildDestination(destination).remove(run.archive_path);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Rimozione dell'archivio fallita";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }
  }

  await db.deleteFrom("backup_runs").where("id", "=", runId).execute();
  removeLogFile(backupLogPath(runId));

  return NextResponse.json({ ok: true });
}
