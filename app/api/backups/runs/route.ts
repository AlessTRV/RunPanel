import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { visiblePolicyIds } from "@/lib/backup-access";
import { backupOverview, listRuns } from "@/services/backup/catalog";
import { activeBackupRunId } from "@/services/backup/runner";

export async function GET(request: NextRequest) {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;

  const url = new URL(request.url);
  const policyId = url.searchParams.get("policyId") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

  const [allRuns, overview, visible] = await Promise.all([
    listRuns(limit, policyId),
    backupOverview(),
    visiblePolicyIds(denied.principal),
  ]);
  // A run with no policy, or of a policy they cannot see, is the owner's.
  const runs = allRuns.filter((run) => visible === "all" || (run.policyId !== null && visible.has(run.policyId)));

  return NextResponse.json({
    runs,
    overview,
    // The page polls this endpoint anyway, so it is also how it learns a run is
    // in flight without a second request.
    activeRunId: activeBackupRunId(),
  });
}
