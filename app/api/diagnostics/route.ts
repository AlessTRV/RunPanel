import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { diagnosticsCache, worstTone } from "@/services/diagnostics";

/**
 * The health of this installation, computed once and rendered in three places:
 * the diagnostics page, the dashboard's alert list, and the first-run
 * checklist. A second opinion computed elsewhere is how a panel ends up saying
 * two different things about the same machine.
 */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const checks = await diagnosticsCache.get();
  return NextResponse.json({
    checks,
    tone: worstTone(checks),
    problems: checks.filter((check) => check.tone === "warn" || check.tone === "danger").length,
  });
}
