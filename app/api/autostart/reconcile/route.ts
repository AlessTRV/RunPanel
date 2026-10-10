import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { reconcileAutostart } from "@/services/autostart/reconcile";

/**
 * Run the boot reconciliation now, or ask what it would do.
 *
 * Safe to expose behind a button because the reconciler is idempotent by
 * construction: it inspects before it acts and starts only what is down.
 */
export async function POST(request: NextRequest) {
  return withAudit(request, { category: "system", action: "autostart.reconcile", scope: "permission", scopeId: "autostart" }, async () => {
    const denied = await requirePermission("autostart");
    if (isDenied(denied)) return denied;

    const body = await request.json().catch(() => ({}));
    const dryRun = body?.dryRun === true;

    try {
      return NextResponse.json(await reconcileAutostart({ dryRun }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Riconciliazione fallita";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
