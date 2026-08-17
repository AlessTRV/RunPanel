import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { serviceDataPathSchema } from "@/lib/validation";
import { isDockerAvailable } from "@/services/docker/cli";
import {
  DataMoveRefused,
  deletePreviousData,
  startDataMove,
} from "@/services/service-data-move";

type Params = { params: Promise<{ serviceId: string }> };

/** The slug is part of every volume name and of the network the container joins. */
async function projectSlugFor(projectId: string | null): Promise<string | undefined> {
  if (!projectId) return undefined;
  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select("slug")
    .where("id", "=", projectId)
    .executeTakeFirst();
  return project?.slug;
}

async function loadService(serviceId: string) {
  const db = await getDb();
  return db.selectFrom("services").selectAll().where("id", "=", serviceId).executeTakeFirst();
}

/**
 * Move a service's data somewhere else, or bring it back to the default volume.
 *
 * Answers 202 as soon as the journal exists, the way a backup run does: the
 * work outlives the request, and the browser follows it on the service's event
 * stream rather than holding a connection open for a copy that can take
 * minutes.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { serviceId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const parsed = serviceDataPathSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const service = await loadService(serviceId);
  if (!service) return NextResponse.json({ error: "Servizio non trovato" }, { status: 404 });

  if (!(await isDockerAvailable())) {
    return NextResponse.json({ error: "Docker non è raggiungibile" }, { status: 503 });
  }

  try {
    const journal = await startDataMove(
      service,
      await projectSlugFor(service.project_id),
      parsed.data
    );
    return NextResponse.json({ status: "started", move: journal }, { status: 202 });
  } catch (err) {
    // The one machine-readable discriminator in this codebase, and it earns it:
    // the card has to answer `destination-not-empty` by revealing a checkbox,
    // and deciding that by matching an Italian sentence is how a copy edit
    // silently disables a safety.
    if (err instanceof DataMoveRefused) {
      return NextResponse.json(
        { error: err.message, code: err.code, entries: err.entries },
        { status: 409 }
      );
    }
    const message = err instanceof Error ? err.message : "Spostamento non riuscito";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * Delete what the last move left behind.
 *
 * Separate from the move, and after it, on purpose: the point of leaving the
 * old copy in place is that somebody looks at the new one first.
 */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { serviceId } = await params;
  const service = await loadService(serviceId);
  if (!service) return NextResponse.json({ error: "Servizio non trovato" }, { status: 404 });

  try {
    const result = await deletePreviousData(service);
    // A host directory comes back as a command rather than an action: RunPanel
    // does not `rm -rf` a path an operator typed.
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DataMoveRefused) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Eliminazione non riuscita";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
