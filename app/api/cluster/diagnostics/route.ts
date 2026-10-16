import { NextRequest } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { json, perServer } from "@/services/cluster/aggregate";
import { fanOut } from "@/services/cluster/fanout";

/** /api/diagnostics of every server; `?fresh=1` asks each for a new reading. */
export async function GET(request: NextRequest) {
  const denied = await requirePermission("diagnostics");
  if (isDenied(denied)) return denied;
  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  const results = await fanOut(`/api/diagnostics${fresh ? "?fresh=1" : ""}`, {
    userId: denied.session.user.id,
    timeoutMs: fresh ? 30_000 : 5_000,
  });
  return json({ servers: perServer(results) });
}
