import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { enqueueDeploy } from "@/services/deploy-queue";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;

  let mode: "deploy" | "rebuild" = "deploy";
  try {
    const body = await request.json();
    if (body.mode === "rebuild") mode = "rebuild";
  } catch { /* no body or invalid JSON — default to deploy */ }

  const result = await enqueueDeploy(projectId, {
    mode,
    trigger: "manual",
    commitSha: null,
    commitMessage: null,
  });

  if (result.status === "not-found") {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  // A request that lands during a deploy is remembered rather than refused, so
  // pressing Deploy twice does not lose the second intent.
  if (result.status === "queued") {
    return NextResponse.json(
      { status: "queued", mode, message: "Deploy in corso — questo verrà eseguito subito dopo" },
      { status: 202 }
    );
  }

  return NextResponse.json(
    {
      deploymentId: result.deploymentId,
      status: "pending",
      mode,
      message: mode === "rebuild" ? "Re-build started" : "Deployment started",
    },
    { status: 202 }
  );
}
