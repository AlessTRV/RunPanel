import { isDenied, requireUser } from "@/lib/auth-guard";
import { aggregateList, json } from "@/services/cluster/aggregate";

/** GET /api/services of every server, each row tagged with its server. */
export async function GET() {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;
  return json(await aggregateList("/api/services", denied.session.user.id));
}
