import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { pinActionSchema } from "@/lib/validation";
import { enqueueDeploy } from "@/services/deploy-queue";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Letting go of a commit.
 *
 * The pin is *set* by deploying a commit — see the deploy route — so this side
 * only has to undo it. Releasing and redeploying is one call rather than two
 * because between them the project would sit unpinned while still running the
 * old commit, and a poller tick landing in that gap would be the panel
 * deploying on its own.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const parsed = pinActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["id", "source_branch", "pinned_sha"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  await db
    .updateTable("projects")
    .set({
      pinned_sha: null,
      pinned_at: null,
      /*
        Cleared for the same reason the deployTrigger guard clears it in the
        project PATCH: the poller stopped looking while the project was held, so
        `poll_sha` is whatever the branch was at some point in the past. Left in
        place, the first tick after the release compares today's head against it,
        finds them different, and deploys on its own. Nulling it is enough — the
        baseline guard ("the first look records and does not deploy") tests for
        exactly that.
      */
      poll_sha: null,
      updated_at: nowIso(),
    })
    .where("id", "=", projectId)
    .execute();

  if (!parsed.data.deploy) {
    return NextResponse.json({ pinned: null, deploy: null });
  }

  const result = await enqueueDeploy(projectId, {
    mode: "deploy",
    trigger: "manual",
    commitSha: null,
    commitMessage: null,
  });

  return NextResponse.json({
    pinned: null,
    branch: project.source_branch,
    deploy: result,
  });
}
