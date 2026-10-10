import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject, requireUser } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { readBuildLog } from "@/services/build-logs";

type Params = { params: Promise<{ deploymentId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;

  const { deploymentId } = await params;
  const db = await getDb();

  const deployment = await db
    .selectFrom("deployments")
    .selectAll()
    .where("id", "=", deploymentId)
    .executeTakeFirst();

  if (!deployment) {
    return NextResponse.json({ error: "Deploy non trovato" }, { status: 404 });
  }
  // A deployment is the project's: whoever cannot read the project gets the
  // same 404 as for an unknown id.
  const allowed = await requireProject(deployment.project_id, "logs");
  if (isDenied(allowed)) return NextResponse.json({ error: "Deploy non trovato" }, { status: 404 });

  // The log is read from disk rather than a column. `?tail=N` keeps a long
  // build from shipping megabytes to a browser that only shows the end of it.
  const tailParam = request.nextUrl.searchParams.get("tail");
  const tail = tailParam ? Math.max(1, Math.min(10_000, Number.parseInt(tailParam, 10) || 0)) : undefined;

  return NextResponse.json(
    { ...deployment, build_log: readBuildLog(deploymentId, tail) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
