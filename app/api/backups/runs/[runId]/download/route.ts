import path from "path";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { buildDestination } from "@/services/backup/destinations";
import { assertBackupId } from "@/services/backup/paths";

type Params = { params: Promise<{ runId: string }> };

/**
 * Hand the archive to the browser.
 *
 * This is the one endpoint that turns an identifier from the outside world into
 * a file read, so it is deliberately narrow: the id is shape-checked, the path
 * is never taken from the request but looked up from the run's own row, and the
 * destination resolves it with a containment check of its own. A client cannot
 * name a path here even if it wants to.
 */
export async function GET(_request: NextRequest, { params }: Params) {
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

  if (!run?.archive_path || !run.destination_id) {
    return NextResponse.json({ error: "Questo backup non ha un archivio" }, { status: 404 });
  }

  const destinationRow = await db
    .selectFrom("backup_destinations")
    .selectAll()
    .where("id", "=", run.destination_id)
    .executeTakeFirst();

  if (!destinationRow) {
    return NextResponse.json({ error: "Destinazione non più configurata" }, { status: 404 });
  }

  try {
    const destination = buildDestination(destinationRow);
    const stream = await destination.open(run.archive_path);
    const fileName = path.basename(run.archive_path);

    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(run.archive_bytes ?? 0),
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
        // The archive's own digest, so a download can be checked without
        // trusting the transfer.
        ...(run.checksum ? { "X-Checksum-Sha256": run.checksum } : {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Archivio non leggibile";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
