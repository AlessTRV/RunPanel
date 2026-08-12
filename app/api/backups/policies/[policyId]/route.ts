import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { updateBackupPolicySchema } from "@/lib/validation";
import { listPolicies } from "@/services/backup/catalog";
import { refreshNextRun } from "@/services/backup/scheduler";

type Params = { params: Promise<{ policyId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { policyId } = await params;
  const policy = (await listPolicies()).find((entry) => entry.id === policyId);
  if (!policy) return NextResponse.json({ error: "Pianificazione non trovata" }, { status: 404 });

  return NextResponse.json(policy);
}

export async function PUT(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { policyId } = await params;
  // A malformed body is a bad request, not a 500.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const parsed = updateBackupPolicySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = await getDb();
  const existing = await db
    .selectFrom("backup_policies")
    .select("id")
    .where("id", "=", policyId)
    .executeTakeFirst();

  if (!existing) {
    return NextResponse.json({ error: "Pianificazione non trovata" }, { status: 404 });
  }

  const data = parsed.data;
  const patch: Record<string, unknown> = { updated_at: nowIso() };

  if (data.name !== undefined) patch.name = data.name;
  if (data.enabled !== undefined) patch.enabled = data.enabled ? 1 : 0;
  if (data.cron !== undefined) patch.cron = data.cron;
  if (data.timezone !== undefined) patch.timezone = data.timezone;
  if (data.destinationId !== undefined) patch.destination_id = data.destinationId;
  if (data.targets !== undefined) patch.targets = JSON.stringify(data.targets);
  if (data.retentionCount !== undefined) patch.retention_count = data.retentionCount;
  if (data.retentionDays !== undefined) patch.retention_days = data.retentionDays;
  if (data.retentionBytes !== undefined) patch.retention_bytes = data.retentionBytes;
  if (data.includeSecretKey !== undefined) {
    patch.include_secret_key = data.includeSecretKey ? 1 : 0;
  }

  await db.updateTable("backup_policies").set(patch).where("id", "=", policyId).execute();

  // The schedule or the switch may have moved; recompute now so the list is
  // right immediately instead of after the next tick.
  await refreshNextRun(policyId);

  const policy = (await listPolicies()).find((entry) => entry.id === policyId);
  return NextResponse.json(policy);
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { policyId } = await params;
  const db = await getDb();

  // The runs survive: `policy_id` is set null rather than cascaded, because the
  // archives are files on disk and deleting the rows would strand them.
  await db.deleteFrom("backup_policies").where("id", "=", policyId).execute();

  return NextResponse.json({ ok: true });
}
