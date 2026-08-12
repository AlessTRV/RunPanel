import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { decrypt } from "@/lib/auth";
import { internalPort, removeService } from "@/services/service-provisioner";
import { networkName } from "@/services/docker/labels";
import { connectionEnvKey } from "@/lib/service-env";

type Params = { params: Promise<{ serviceId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { serviceId } = await params;
  const reveal = request.nextUrl.searchParams.get("reveal") === "true";

  const db = await getDb();
  const service = await db
    .selectFrom("services")
    .selectAll()
    .where("id", "=", serviceId)
    .executeTakeFirst();

  if (!service) {
    return NextResponse.json({ error: "Servizio non trovato" }, { status: 404 });
  }

  // A service reachable by container name is one that shares a network with the
  // caller, and only a project gives it one. Resolved here so the page can name
  // the network instead of alluding to a project it may not have.
  const project = service.project_id
    ? await db
        .selectFrom("projects")
        .select("slug")
        .where("id", "=", service.project_id)
        .executeTakeFirst()
    : undefined;

  // The facts the detail page needs to explain how to connect, resolved here
  // because they come from the service templates — server-side knowledge the
  // browser has no business restating.
  return NextResponse.json({
    ...service,
    containerName: service.container_name,
    internalPort: internalPort(service.type, service.port),
    envKey: connectionEnvKey(service.type),
    projectSlug: project?.slug ?? null,
    networkName: project ? networkName(project.slug) : null,
    credentials: reveal && service.credentials ? decrypt(service.credentials) : "hidden",
  }, {
    // `?reveal=true` returns the database password in clear. Not cacheable
    // anywhere, by anything.
    headers: { "Cache-Control": "no-store" },
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { serviceId } = await params;
  const db = await getDb();
  const service = await db
    .selectFrom("services")
    .selectAll()
    .where("id", "=", serviceId)
    .executeTakeFirst();

  if (!service) {
    return NextResponse.json({ error: "Servizio non trovato" }, { status: 404 });
  }

  // The project slug is part of a service's volume names, so it has to be
  // resolved before they can be named — not to scope a search.
  const project = service.project_id
    ? await db
        .selectFrom("projects")
        .select("slug")
        .where("id", "=", service.project_id)
        .executeTakeFirst()
    : undefined;

  // Deleting a service deletes its data. This is the point of no return, so the
  // client has to ask for it explicitly with ?deleteData=true; the UI confirms
  // first. Previously the volume was simply left behind forever, and a service
  // recreated with the same name silently inherited the old database.
  const deleteData = request.nextUrl.searchParams.get("deleteData") === "true";

  let volumesRemoved: string[] = [];
  try {
    const result = await removeService(service.container_name, {
      removeData: deleteData,
      service: { type: service.type, name: service.name, projectSlug: project?.slug },
    });
    volumesRemoved = result.volumesRemoved;
  } catch { /* ignore */ }

  await db.deleteFrom("services").where("id", "=", serviceId).execute();
  return NextResponse.json({ success: true, volumesRemoved });
}
