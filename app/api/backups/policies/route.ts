import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { policyProblem, visiblePolicyIds } from "@/lib/backup-access";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { backupPolicySchema } from "@/lib/validation";
import { listPolicies } from "@/services/backup/catalog";
import { defaultDestinationId } from "@/services/backup/destinations";
import { refreshNextRun } from "@/services/backup/scheduler";

export async function GET() {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;

  const visible = await visiblePolicyIds(denied.principal);
  const policies = (await listPolicies()).filter((p) => visible === "all" || visible.has(p.id));
  return NextResponse.json({ policies });
}

export async function POST(request: NextRequest) {
  return withAudit(request, { category: "backup", action: "backup.policy.create", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;

    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }

    const parsed = backupPolicySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const data = parsed.data;
    const problem = await policyProblem(denied.principal, data.targets, Boolean(data.includeSecretKey));
    if (problem) return NextResponse.json({ error: problem }, { status: 403 });
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
  });
}
