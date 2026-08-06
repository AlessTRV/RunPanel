import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { decrypt } from "@/lib/auth";
import { removeService, serviceContainerName } from "@/services/service-provisioner";

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
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...service,
    credentials: reveal && service.credentials ? decrypt(service.credentials) : "hidden",
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
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }

  // Volumes are labelled with the project slug, so resolve it to scope the
  // lookup rather than searching every volume RunPanel owns.
  const project = service.project_id
    ? await db
        .selectFrom("projects")
        .select("slug")
        .where("id", "=", service.project_id)
        .executeTakeFirst()
    : undefined;
  const projectSlug = project?.slug;

  // Resolve container name from config or legacy unscoped fallback
  let containerName = "";
  try {
    containerName = (JSON.parse(service.config || "{}") as { containerName?: string }).containerName ?? "";
  } catch { /* fall through to the derived name */ }
  if (!containerName) {
    containerName = serviceContainerName(service.name);
  }

  // Deleting a service deletes its data. This is the point of no return, so the
  // client has to ask for it explicitly with ?deleteData=true; the UI confirms
  // first. Previously the volume was simply left behind forever, and a service
  // recreated with the same name silently inherited the old database.
  const deleteData = request.nextUrl.searchParams.get("deleteData") === "true";

  let volumesRemoved: string[] = [];
  try {
    const result = await removeService(containerName, {
      removeData: deleteData,
      projectSlug,
      serviceName: service.name,
    });
    volumesRemoved = result.volumesRemoved;
  } catch { /* ignore */ }

  await db.deleteFrom("services").where("id", "=", serviceId).execute();
  return NextResponse.json({ success: true, volumesRemoved });
}
