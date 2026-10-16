import { isDenied, requirePermission } from "@/lib/auth-guard";
import { json, perServer } from "@/services/cluster/aggregate";
import { fanOut } from "@/services/cluster/fanout";

/** /api/monitor of every server, one entry per server. */
export async function GET() {
  const denied = await requirePermission("monitor");
  if (isDenied(denied)) return denied;
  return json({ servers: perServer(await fanOut("/api/monitor", { userId: denied.session.user.id })) });
}
