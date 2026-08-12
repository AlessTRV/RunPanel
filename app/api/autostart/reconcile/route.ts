import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { reconcileAutostart } from "@/services/autostart/reconcile";

/**
 * Run the boot reconciliation now, or ask what it would do.
 *
 * Safe to expose behind a button because the reconciler is idempotent by
 * construction: it inspects before it acts and starts only what is down.
 */
export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;

  try {
    return NextResponse.json(await reconcileAutostart({ dryRun }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Riconciliazione fallita";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
