import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { requireHostFor } from "@/lib/host-guard";
import { withAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { projectMountsSchema } from "@/lib/validation";
import { isDockerAvailable } from "@/services/docker/cli";
import { applyProjectMounts } from "@/services/project-mounts";
import { MountRefused } from "@/services/service-mounts";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Replace a project's bind list.
 *
 * Separate from `PATCH /api/projects/:id`, which saves the settings form,
 * because this is not a form save: it copies bytes and restarts the app. The
 * PATCH carries the stored mounts forward untouched for the same reason —
 * saving the settings tab must not be able to revert a list edited here, nor
 * write one without the copy that has to precede it.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.mounts", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "mounts");
    if (isDenied(denied)) return denied;
    const noHost = requireHostFor(denied.principal, "montare cartelle dell'host");
    if (noHost) return noHost;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }

    const parsed = projectMountsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const db = await getDb();
    const project = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();

    if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

    if (!(await isDockerAvailable())) {
      return NextResponse.json({ error: "Docker non è raggiungibile" }, { status: 503 });
    }

    try {
      const journal = await applyProjectMounts(project, parsed.data.mounts, {
        adopt: parsed.data.adopt,
      });
      return NextResponse.json({ status: "started", apply: journal }, { status: 202 });
    } catch (err) {
      if (err instanceof MountRefused) {
        return NextResponse.json(
          { error: err.message, code: err.code, target: err.mountId, entries: err.entries },
          { status: 409 }
        );
      }
      const message = err instanceof Error ? err.message : "Applicazione non riuscita";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}
