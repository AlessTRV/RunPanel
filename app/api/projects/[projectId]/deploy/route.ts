import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { deployRequestSchema } from "@/lib/validation";
import { enqueueDeploy } from "@/services/deploy-queue";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;

  // An empty body is how the Deploy button has always asked, so it stays valid.
  let body: unknown = {};
  try {
    body = await request.json();
  } catch { /* no body, or not JSON — the schema's defaults cover it */ }

  const parsed = deployRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const mode = parsed.data.mode ?? "deploy";
  const commitSha = parsed.data.commitSha ?? null;

  // Refused rather than ignored: a re-build never touches git, so honouring the
  // commit would mean rebuilding whatever is already checked out while the
  // panel reported the commit that was asked for.
  if (mode === "rebuild" && commitSha) {
    return NextResponse.json(
      { error: "Il re-build ricostruisce i file già sul disco: per cambiare commit serve un deploy." },
      { status: 400 }
    );
  }

  if (commitSha) {
    const db = await getDb();
    const project = await db
      .selectFrom("projects")
      .select(["id", "source_type", "source_url"])
      .where("id", "=", projectId)
      .executeTakeFirst();

    if (!project) {
      return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
    }

    if (project.source_type !== "github" || !project.source_url) {
      return NextResponse.json(
        { error: "Questo progetto non parte da un repository GitHub: non c'è un commit da scegliere." },
        { status: 400 }
      );
    }

    /*
      Written before the deploy is queued, and the order is load-bearing.

      `claim()` SELECTs the project row and then conditionally UPDATEs it, so the
      row the pipeline receives is the one that existed when the deploy started.
      Pinning afterwards would race the very deploy it is meant to direct.

      It is also what makes the choice outlast this request: from here on every
      deploy of this project rebuilds this commit, and auto-deploy is suspended,
      until the pin is released.
    */
    await db
      .updateTable("projects")
      .set({ pinned_sha: commitSha, pinned_at: nowIso(), updated_at: nowIso() })
      .where("id", "=", projectId)
      .execute();
  }

  const result = await enqueueDeploy(projectId, {
    mode,
    trigger: "manual",
    // Recorded on the deployment row up front, so the history shows what was
    // asked for even when the checkout never gets as far as reading the commit
    // message. The pipeline overwrites both with the real object once it has it.
    commitSha,
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
