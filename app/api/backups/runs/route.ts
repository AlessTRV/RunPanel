import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { backupOverview, listRuns } from "@/services/backup/catalog";
import { activeBackupRunId } from "@/services/backup/runner";

export async function GET(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const url = new URL(request.url);
  const policyId = url.searchParams.get("policyId") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

  const [runs, overview] = await Promise.all([listRuns(limit, policyId), backupOverview()]);

  return NextResponse.json({
    runs,
    overview,
    // The page polls this endpoint anyway, so it is also how it learns a run is
    // in flight without a second request.
    activeRunId: activeBackupRunId(),
  });
}
