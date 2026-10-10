import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireService } from "@/lib/auth-guard";
import { requireHostFor } from "@/lib/host-guard";
import { withAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { serviceMountsSchema } from "@/lib/validation";
import { isDockerAvailable } from "@/services/docker/cli";
import { MountRefused, applyMounts } from "@/services/service-mounts";

type Params = { params: Promise<{ serviceId: string }> };

/**
 * Replace a service's bind list.
 *
 * The whole list at once, not one mount at a time: every application recreates
 * the container, and doing it per row would stop the service once per edit.
 *
 * Answers 202 as soon as the journal exists, the way a backup run does — seeding
 * a large folder outlives the request, and the browser follows it on the
 * service's event stream rather than holding a connection open for minutes.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "service.mounts", scope: "service", scopeId: async () => (await params).serviceId }, async () => {
    const { serviceId } = await params;
    const denied = await requireService(serviceId, "mounts");
    if (isDenied(denied)) return denied;
    const noHost = requireHostFor(denied.principal, "montare cartelle dell'host");
    if (noHost) return noHost;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }

    const parsed = serviceMountsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const db = await getDb();
    const service = await db
      .selectFrom("services")
      .selectAll()
      .where("id", "=", serviceId)
      .executeTakeFirst();

    if (!service) return NextResponse.json({ error: "Servizio non trovato" }, { status: 404 });

    if (!(await isDockerAvailable())) {
      return NextResponse.json({ error: "Docker non è raggiungibile" }, { status: 503 });
    }

    const project = service.project_id
      ? await db
          .selectFrom("projects")
          .select("slug")
          .where("id", "=", service.project_id)
          .executeTakeFirst()
      : undefined;

    try {
      const journal = await applyMounts(service, project?.slug, parsed.data.mounts, {
        adopt: parsed.data.adopt,
        releaseData: parsed.data.releaseData,
      });
      return NextResponse.json({ status: "started", apply: journal }, { status: 202 });
    } catch (err) {
      // The one machine-readable discriminator in this codebase, and it earns it:
      // the card has to answer `destination-not-empty` by revealing a checkbox on
      // one specific row, and deciding that by matching an Italian sentence is how
      // a copy edit silently disables a safety.
      if (err instanceof MountRefused) {
        return NextResponse.json(
          { error: err.message, code: err.code, mountId: err.mountId, entries: err.entries },
          { status: 409 }
        );
      }
      const message = err instanceof Error ? err.message : "Applicazione non riuscita";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}
