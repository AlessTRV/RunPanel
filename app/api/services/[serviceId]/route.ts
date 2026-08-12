import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { updateServiceSchema } from "@/lib/validation";
import { internalPort, removeService } from "@/services/service-provisioner";
import { networkName } from "@/services/docker/labels";
import {
  connectToNetwork,
  disconnectFromNetwork,
  ensureProjectNetwork,
} from "@/services/docker-network";
import { serviceEnvKey, suggestEnvKey } from "@/lib/service-env";

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
    // The key this link actually provides, not the type's default: the two
    // differ as soon as a project has two databases of the same kind.
    envKey: serviceEnvKey(service),
    injectEnv: service.inject_env === 1,
    projectSlug: project?.slug ?? null,
    networkName: project ? networkName(project.slug) : null,
    credentials: reveal && service.credentials ? decrypt(service.credentials) : "hidden",
  }, {
    // `?reveal=true` returns the database password in clear. Not cacheable
    // anywhere, by anything.
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Change how a service is attached to a project.
 *
 * Three things, all of which used to be impossible after creation: whether the
 * link injects its connection URL, under which variable name, and whether the
 * link exists at all. The last one is why this handler exists — detaching a
 * database previously meant deleting the service, and deleting a service is a
 * dialog about destroying data.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { serviceId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const parsed = updateServiceSchema.safeParse(body);
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

  if (!service) {
    return NextResponse.json({ error: "Servizio non trovato" }, { status: 404 });
  }

  const { projectId, injectEnv, envKey } = parsed.data;
  const detaching = projectId === null && service.project_id !== null;
  const attaching = typeof projectId === "string" && projectId !== service.project_id;

  const nextProjectId = projectId === undefined ? service.project_id : projectId;
  const nextInject = detaching
    ? 0
    : injectEnv === undefined
      ? (attaching ? 1 : (service.inject_env ?? 0))
      : injectEnv
        ? 1
        : 0;
  const nextEnvKey = envKey === undefined ? service.env_key : envKey;

  // Two links in one project cannot answer to the same variable. Checked before
  // anything is written, so a rejected request changes nothing.
  if (nextProjectId && nextInject === 1) {
    const resolved = serviceEnvKey({ type: service.type, env_key: nextEnvKey });
    const siblings = await db
      .selectFrom("services")
      .select(["id", "name", "type", "env_key", "inject_env"])
      .where("project_id", "=", nextProjectId)
      .where("id", "!=", serviceId)
      .execute();

    const clash = siblings.find(
      (row) => row.inject_env === 1 && serviceEnvKey(row) === resolved
    );
    if (clash) {
      return NextResponse.json(
        {
          error: `${resolved} è già fornita da "${clash.name}". Dai a questo collegamento un'altra variabile.`,
          suggestedEnvKey: suggestEnvKey(service.name, service.type),
        },
        { status: 409 }
      );
    }
  }

  // Moving between projects is a network change, not just a column. The
  // container keeps its name — `container_name` exists precisely so the name is
  // never re-derived — so only its network membership moves.
  if (detaching || attaching) {
    const previous = service.project_id
      ? await db
          .selectFrom("projects")
          .select("slug")
          .where("id", "=", service.project_id)
          .executeTakeFirst()
      : undefined;

    if (previous) {
      await disconnectFromNetwork(service.container_name, previous.slug);
    }

    if (attaching) {
      const target = await db
        .selectFrom("projects")
        .select("slug")
        .where("id", "=", projectId as string)
        .executeTakeFirst();

      if (!target) {
        return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
      }

      await ensureProjectNetwork(target.slug);
      await connectToNetwork(service.container_name, target.slug);
    }
  }

  await db
    .updateTable("services")
    .set({
      project_id: nextProjectId,
      inject_env: nextInject,
      env_key: nextEnvKey,
      updated_at: nowIso(),
    })
    .where("id", "=", serviceId)
    .execute();

  const updated = await db
    .selectFrom("services")
    .selectAll()
    .where("id", "=", serviceId)
    .executeTakeFirst();

  return NextResponse.json({
    ...updated,
    envKey: serviceEnvKey({ type: service.type, env_key: nextEnvKey }),
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
