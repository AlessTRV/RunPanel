import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { oneTimeCommandsSchema } from "@/lib/validation";
import { phaseLabel, phaseUnavailableReason } from "@/lib/deploy-phases";
import {
  clearHistory,
  hasClaimed,
  historyForProject,
  queuedForProject,
  replaceQueue,
} from "@/services/one-time-commands";

type Params = { params: Promise<{ projectId: string }> };

/**
 * A project's one-time commands: the queue waiting for the next deploy, and the
 * record of the ones already spent.
 *
 * Its own route rather than a corner of `PATCH /api/projects/:id`, for the same
 * reason the bind list has one: the settings form sends the whole contract on
 * every save, so anything sharing that column can be reverted by a save made
 * from a form that was opened before it. These rows also change under the
 * panel's feet — a deploy drains the queue while somebody is looking at it —
 * which is not a thing a form field can be.
 *
 * Unlike the mount route this starts nothing, so it answers 200 rather than 202.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const db = await getDb();

  const project = await db
    .selectFrom("projects")
    .select(["id", "runtime_type"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

  // The history is the expensive half and nobody looks at it until they open
  // the panel that shows it, so it is asked for rather than assumed.
  const wantsHistory = request.nextUrl.searchParams.get("include") === "history";

  return NextResponse.json({
    queued: await queuedForProject(projectId, project.runtime_type),
    history: wantsHistory ? await historyForProject(projectId, project.runtime_type) : [],
  });
}

/**
 * Replace the queue.
 *
 * Replace semantics, like the bind list: the body is the whole queue, not a
 * patch. A row that comes back with its `id` keeps its attempt count and the
 * note from the tentativo that failed — see `replaceQueue`.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const parsed = oneTimeCommandsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["id", "runtime_type"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

  /*
    Refused while a deploy holds any of these rows.

    Not a nicety: the queue is replaced by id, and a deploy that has already
    claimed a row would have it deleted from under it — or, worse, see the same
    command re-inserted as queued and run it a second time on the next deploy.
    Asked of the rows themselves rather than of `projects.status`, which says
    "deploying" for a while before and after the claim.
  */
  if (await hasClaimed(projectId)) {
    return NextResponse.json(
      {
        error:
          "Un deploy in corso ha già preso i comandi in coda. Riprova quando è finito.",
        code: "deploy-in-progress",
      },
      { status: 409 }
    );
  }

  /*
    Refused for a row being written here, not for one that is merely still
    there.

    Checking every row meant that changing a project's runtime made the whole
    section unsaveable: the editor sends the full queue, so one row stranded on
    a phase the new runtime does not have rejected every later edit with a 400
    about a command the operator was not touching. The section flagged the
    stranded row and said it would stay in the queue — which cannot both be
    true and be a reason to refuse the save. So an unchanged stored row is
    allowed through and keeps its warning; a new or edited one is not.
  */
  const stored = new Map(
    (await queuedForProject(projectId, project.runtime_type)).map((row) => [row.id, row])
  );

  for (const command of parsed.data.commands) {
    const reason = phaseUnavailableReason(command.phase, project.runtime_type);
    if (!reason) continue;

    const previous = command.id ? stored.get(command.id) : undefined;
    const unchanged =
      previous !== undefined &&
      previous.phase === command.phase &&
      previous.command === command.command;
    if (unchanged) continue;

    return NextResponse.json(
      { error: `"${phaseLabel(command.phase)}": ${reason}`, code: "phase-unavailable" },
      { status: 400 }
    );
  }

  const queued = await replaceQueue(projectId, project.runtime_type, parsed.data.commands);
  return NextResponse.json({ queued });
}

/** Empty the history. The queue and anything in flight are left alone. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const db = await getDb();

  const project = await db
    .selectFrom("projects")
    .select("id")
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

  return NextResponse.json({ removed: await clearHistory(projectId) });
}
