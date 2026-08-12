import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { restoreRequestSchema } from "@/lib/validation";
import { RestoreBusyError, startRestore } from "@/services/backup/restore";
import { activeBackupRunId } from "@/services/backup/runner";

/**
 * Start a restore.
 *
 * The confirmation is checked here as well as in the browser: the operator has
 * to have typed the target's real name, and the server is where that has to be
 * true. Answers as soon as the row exists — the work continues, and the id in
 * the response is what the page follows.
 */
export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const parsed = restoreRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const data = parsed.data;

  if (activeBackupRunId()) {
    return NextResponse.json(
      { error: "Un backup è in corso: attendi che finisca prima di ripristinare" },
      { status: 409 }
    );
  }

  if (data.runId) {
    const db = await getDb();
    const run = await db
      .selectFrom("backup_runs")
      .select("id")
      .where("id", "=", data.runId)
      .executeTakeFirst();
    if (!run) return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });

    // The confirmation has to be the real name of the first thing that will be
    // overwritten. Enforced here and not only in the browser: a check that can
    // be skipped by posting directly is not a check.
    const chosen = data.targets.filter((target) => target.action === "restore");
    const artifacts = await db
      .selectFrom("backup_artifacts")
      .select(["id", "ref_name"])
      .where("run_id", "=", data.runId)
      .execute();

    const names = new Map(artifacts.map((artifact) => [artifact.id, artifact.ref_name]));
    const expected = names.get(chosen[0]?.artifactId ?? "");

    if (!expected) {
      return NextResponse.json(
        { error: "L'elemento selezionato non appartiene a questo backup" },
        { status: 400 }
      );
    }
    if (data.confirm.trim() !== expected) {
      return NextResponse.json(
        { error: `Per confermare devi scrivere esattamente: ${expected}` },
        { status: 400 }
      );
    }
  }

  try {
    const { restoreId, done } = await startRestore({
      runId: data.runId,
      uploadId: data.uploadId,
      mappings: data.targets,
      skipSafetyBackup: data.skipSafetyBackup,
    });

    // The failure is already recorded on the restore row; this only keeps Node
    // from treating the rejection as unhandled.
    void done.catch(() => {});

    return NextResponse.json({ restoreId }, { status: 202 });
  } catch (err) {
    if (err instanceof RestoreBusyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Avvio del ripristino fallito";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
