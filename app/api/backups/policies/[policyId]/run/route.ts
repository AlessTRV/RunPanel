import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { BackupBusyError, startBackup } from "@/services/backup/runner";
import { parseTargets } from "@/services/backup/scheduler";

type Params = { params: Promise<{ policyId: string }> };

/**
 * Run a policy now.
 *
 * Answers as soon as the run's row exists and lets the work continue, because a
 * backup takes minutes and an HTTP request that waits for one is a request that
 * times out somewhere in between. The id in the response is what the page opens
 * its log stream on.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { policyId } = await params;
  const db = await getDb();

  const policy = await db
    .selectFrom("backup_policies")
    .selectAll()
    .where("id", "=", policyId)
    .executeTakeFirst();

  if (!policy) return NextResponse.json({ error: "Pianificazione non trovata" }, { status: 404 });

  try {
    const { runId, done } = await startBackup({
      trigger: "manual",
      targets: parseTargets(policy.targets),
      destinationId: policy.destination_id,
      policyId: policy.id,
      policyName: policy.name,
      includeSecretKey: policy.include_secret_key === 1,
    });

    // Deliberately not awaited. The rejection is already recorded on the run
    // row by the runner; this only stops Node treating it as unhandled.
    void done.catch(() => {});

    return NextResponse.json({ runId }, { status: 202 });
  } catch (err) {
    if (err instanceof BackupBusyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Avvio del backup fallito";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
