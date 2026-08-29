import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { diagnosticsCache, worstTone } from "@/services/diagnostics";

/**
 * The health of this installation, computed once and rendered in three places:
 * the diagnostics page, the dashboard's alert list, and the first-run
 * checklist. A second opinion computed elsewhere is how a panel ends up saying
 * two different things about the same machine.
 *
 * `?fresh=1` is the "Ricontrolla" button, and the difference is the whole point
 * of the parameter. A poll is answered from a 30s cache because each reading
 * spawns six to ten child processes and three screens are asking; somebody who
 * pressed a button is asking about this second, and used to get that same cache
 * back — the poll had just filled it, so the answer was byte-identical and the
 * page did not so much as re-render.
 */
export async function GET(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  const checks = await diagnosticsCache.get({ fresh });

  return NextResponse.json({
    checks,
    tone: worstTone(checks),
    problems: checks.filter((check) => check.tone === "warn" || check.tone === "danger").length,
    /*
      When this reading was taken, which is not the same as when it was asked
      for. Without it a re-check that finds nothing changed is indistinguishable
      from a re-check that never happened — and that is what the button felt
      like even once it worked.
    */
    checkedAt: new Date(diagnosticsCache.producedAt() ?? Date.now()).toISOString(),
  });
}
