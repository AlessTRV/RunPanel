import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { updateServiceSchema } from "@/lib/validation";
import {
  internalPort,
  recreateService,
  removeService,
} from "@/services/service-provisioner";
import { currentMounts, parseApplyJournal, parseMounts } from "@/services/service-mounts";
import { networkName } from "@/services/docker/labels";
import {
  connectToNetwork,
  disconnectFromNetwork,
  ensureProjectNetwork,
} from "@/services/docker-network";
import { reachesByContainerName, serviceEnvKey, suggestEnvKey } from "@/lib/service-env";
import { parseContractJson } from "@/lib/deploy-contract";
import { AccessRow, readAccess, reportGate, syncGate } from "@/services/access";
import { allocateLoopbackPort, closeGate } from "@/services/access-gate";
import { ServicesTable } from "@/lib/db/schema";

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
        .select(["slug", "runtime_type", "builder_config"])
        .where("id", "=", service.project_id)
        .executeTakeFirst()
    : undefined;

  /**
   * Whether the linked app actually reaches this service by container name.
   *
   * The same condition as `deploy-pipeline.ts`, resolved here so the page
   * cannot disagree with what a deploy really injects — and it did disagree.
   * The detail page offered the container-name line by default to every linked
   * service and said it was «esattamente la riga che RunPanel inietta». For a
   * project running under PM2 that is false twice over: the deploy injects
   * `localhost` and the published port, and a container name does not resolve
   * outside a Docker network at all. Copying the line the panel recommended
   * produced `could not translate host name`.
   */
  const reachedByContainerName = Boolean(
    project &&
      reachesByContainerName(
        project.runtime_type,
        parseContractJson(project.builder_config).docker.network
      )
  );

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
    reachedByContainerName,
    // Who may reach the published port, and whether the gate that enforces it
    // is actually up — the row says what was asked for, the gate says what is.
    access: readAccess(service),
    gate: reportGate("service", service.id),
    // Where the data is, where it would be by default, and whether a move is in
    // flight. Resolved here because the default comes from the template, and
    // because the card that renders all three must not need a fetch of its own:
    // `useResource` throws away the body of any non-2xx, so an explanation sent
    // as an error is an explanation nobody reads.
    // The bind list, and where every mount really is on the host — the one
    // thing a volume name and an in-container path cannot tell you between
    // them. Resolved here because it comes from Docker, and because the card
    // that renders it must not need a fetch of its own: `useResource` throws
    // away the body of any non-2xx, so an explanation sent as an error is an
    // explanation nobody reads.
    mounts: parseMounts(service.mounts),
    mountApply: parseApplyJournal(service.mount_apply),
    containerMounts: await currentMounts(service.container_name),
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

  const { projectId, injectEnv, envKey, access } = parsed.data;
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

  // --- who may reach the port ------------------------------------------------
  const current = readAccess(service);
  const nextAccess: AccessRow = access
    ? {
        access_mode: access.mode,
        access_allow: JSON.stringify(access.allow),
        // Allocated the first time a target is restricted and kept for as long
        // as it stays that way, so the container's publish spec is stable
        // across edits to the list.
        access_port:
          access.mode === "restricted" ? (service.access_port ?? (await allocateLoopbackPort())) : null,
      }
    : { access_mode: service.access_mode, access_allow: service.access_allow, access_port: service.access_port };

  const next = readAccess(nextAccess);
  const bindChanged = next.mode !== current.mode || next.port !== current.port;

  let recreated: { containerId: string; status: ServicesTable["status"] } | null = null;

  if (bindChanged) {
    // Strict order, and both halves matter. Going restricted: the container
    // still holds the public port, so it has to be recreated onto loopback
    // before the gate can bind. Going open: the gate holds the public port, so
    // it has to let go before the container can take it back.
    await closeGate("service", serviceId);

    const slug = nextProjectId
      ? (
          await db
            .selectFrom("projects")
            .select("slug")
            .where("id", "=", nextProjectId)
            .executeTakeFirst()
        )?.slug
      : undefined;

    try {
      recreated = await recreateService(service, slug, nextAccess);
    } catch (err) {
      // Nothing is written: the row keeps describing the container that is
      // actually there. Reopening the previous gate is best-effort — if it
      // fails too, the port stays shut, which is the safe direction.
      await syncGate("service", serviceId, service, {
        publicPort: service.port,
        label: service.name,
      }).catch(() => {});

      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Impossibile applicare la restrizione" },
        { status: 500 }
      );
    }
  }

  await db
    .updateTable("services")
    .set({
      project_id: nextProjectId,
      inject_env: nextInject,
      env_key: nextEnvKey,
      access_mode: nextAccess.access_mode,
      access_allow: nextAccess.access_allow,
      access_port: nextAccess.access_port,
      ...(recreated ? { status: recreated.status } : {}),
      updated_at: nowIso(),
    })
    .where("id", "=", serviceId)
    .execute();

  // After the container, never before: a gate that binds while the old
  // container still publishes the port is an EADDRINUSE, not a gate.
  try {
    await syncGate("service", serviceId, nextAccess, {
      publicPort: service.port,
      label: service.name,
    });
  } catch (err) {
    // The columns are already written and the container is already on loopback,
    // so the port is simply closed. Reported rather than swallowed, because
    // "restricted" and "unreachable" look identical from the outside.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Restrizione salvata, ma la porta non è stata aperta" },
      { status: 500 }
    );
  }

  const updated = await db
    .selectFrom("services")
    .selectAll()
    .where("id", "=", serviceId)
    .executeTakeFirst();

  return NextResponse.json({
    ...updated,
    envKey: serviceEnvKey({ type: service.type, env_key: nextEnvKey }),
    access: readAccess(nextAccess),
    gate: reportGate("service", serviceId),
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

  // Before the container goes: a gate left open would keep holding the public
  // port for a service that no longer exists, and the next one to claim that
  // port would fail to bind for no visible reason.
  await closeGate("service", serviceId);

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
