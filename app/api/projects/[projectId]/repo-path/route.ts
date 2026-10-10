import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { requireHostFor } from "@/lib/host-guard";
import { withAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { repoPathSchema } from "@/lib/validation";
import { RepoMoveRefused, deletePreviousCheckout, startRepoMove } from "@/services/project-repo";

type Params = { params: Promise<{ projectId: string }> };

async function loadProject(projectId: string) {
  const db = await getDb();
  return db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();
}

/**
 * Move a native project's checkout, or bring it back to the default location.
 *
 * Answers 202 as soon as the journal exists: copying a checkout with its
 * `node_modules` runs for minutes, and the browser follows it on the project's
 * event stream rather than holding a connection open.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.repo-path", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;
    const noHost = requireHostFor(denied.principal, "spostare il checkout sul disco");
    if (noHost) return noHost;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }

    const parsed = repoPathSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const project = await loadProject(projectId);
    if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

    try {
      const journal = await startRepoMove(project, parsed.data.path);
      return NextResponse.json({ status: "started", move: journal }, { status: 202 });
    } catch (err) {
      if (err instanceof RepoMoveRefused) {
        return NextResponse.json(
          { error: err.message, code: err.code, entries: err.entries },
          { status: 409 }
        );
      }
      const message = err instanceof Error ? err.message : "Spostamento non riuscito";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}

/** Delete the copy the last move left behind, after the operator has checked. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  return withAudit(_request, { category: "config", action: "project.repo-path.reset", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;
    const noHost = requireHostFor(denied.principal, "spostare il checkout sul disco");
    if (noHost) return noHost;
    const project = await loadProject(projectId);
    if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

    try {
      return NextResponse.json(await deletePreviousCheckout(project));
    } catch (err) {
      if (err instanceof RepoMoveRefused) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
      }
      const message = err instanceof Error ? err.message : "Eliminazione non riuscita";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  });
}
