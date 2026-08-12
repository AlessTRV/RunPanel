import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { backupPolicySchema } from "@/lib/validation";
import { listPolicies } from "@/services/backup/catalog";
import { defaultDestinationId } from "@/services/backup/destinations";
import { refreshNextRun } from "@/services/backup/scheduler";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  return NextResponse.json({ policies: await listPolicies() });
}

export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const parsed = backupPolicySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const data = parsed.data;
  const db = await getDb();

  // A policy pointing at a destination that does not exist would fail every
  // night at three in the morning rather than now, while someone is looking.
  const destination = await db
    .selectFrom("backup_destinations")
    .select("id")
    .where("id", "=", data.destinationId)
    .executeTakeFirst();

  if (!destination) {
    const fallback = await defaultDestinationId();
    if (!fallback) {
      return NextResponse.json({ error: "Nessuna destinazione configurata" }, { status: 400 });
    }
    return NextResponse.json({ error: "Destinazione non trovata" }, { status: 404 });
  }

  const id = generateId();
  const now = nowIso();

  await db
    .insertInto("backup_policies")
    .values({
      id,
      name: data.name,
      enabled: data.enabled === false ? 0 : 1,
      cron: data.cron,
      timezone: data.timezone ?? null,
      destination_id: data.destinationId,
      targets: JSON.stringify(data.targets),
      retention_count: data.retentionCount ?? null,
      retention_days: data.retentionDays ?? null,
      retention_bytes: data.retentionBytes ?? null,
      include_secret_key: data.includeSecretKey ? 1 : 0,
      last_run_at: null,
      // Filled in below rather than left null, so the list shows when it will
      // next run without waiting for a tick to notice the policy exists.
      next_run_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();

  await refreshNextRun(id);

  const policies = await listPolicies();
  return NextResponse.json(
    policies.find((policy) => policy.id === id),
    { status: 201 }
  );
}
