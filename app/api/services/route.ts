import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { createServiceSchema } from "@/lib/validation";
import { encrypt } from "@/lib/crypto";
import { connectionEnvKey, serviceEnvKey, suggestEnvKey } from "@/lib/service-env";
import {
  generateCredentials,
  provisionService,
  getConnectionString,
  removeService,
  serviceContainerName,
} from "@/services/service-provisioner";
import { AccessRow, syncGate } from "@/services/access";
import { allocateLoopbackPort } from "@/services/access-gate";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const db = await getDb();
  const services = await db
    .selectFrom("services")
    .selectAll()
    .orderBy("created_at", "desc")
    .execute();
  return NextResponse.json(services);
}

export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  // A malformed body is a bad request, not a 500.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = createServiceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { name, type, version, port, projectId, credentials: customCreds, access } = parsed.data;
  const id = generateId();
  const defaultCreds = generateCredentials(type);
  const credentials = {
    user: customCreds?.user || defaultCreds.user,
    password: customCreds?.password || defaultCreds.password,
    database: customCreds?.database || defaultCreds.database,
  };

  const db = await getDb();

  // An unknown project used to be accepted silently: the row was written with a
  // project_id nothing points at, while the container was labelled as belonging
  // to no project. The service then claimed a project in the UI, was excluded
  // from every project-scoped query, and was never injected into any deploy.
  let projectSlug: string | undefined;
  if (projectId) {
    const proj = await db
      .selectFrom("projects")
      .select("slug")
      .where("id", "=", projectId)
      .executeTakeFirst();

    if (!proj) {
      return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
    }
    projectSlug = proj.slug;
  }

  const containerName = serviceContainerName(name, projectSlug);

  // Provisioning force-removes any container with this name before creating it.
  // Without this check, a second service claiming the same name would destroy
  // the first one's container and silently adopt its data volume — which is how
  // two standalone services both called `db` would have ended up sharing one
  // database while the panel listed two.
  const clash = await db
    .selectFrom("services")
    .select("name")
    .where("container_name", "=", containerName)
    .executeTakeFirst();

  if (clash) {
    return NextResponse.json(
      {
        error: projectSlug
          ? `Il progetto ha già un servizio chiamato "${name}".`
          : `Esiste già un servizio "${name}". I servizi senza progetto condividono un unico spazio di nomi.`,
      },
      { status: 409 }
    );
  }

  // Two links inside one project cannot both answer to the same variable. The
  // second postgres used to be accepted and then quietly ignored at deploy
  // time; now it is given a distinct name up front, and the response says so.
  let envKey: string | null = null;
  if (projectId) {
    const siblings = await db
      .selectFrom("services")
      .select(["name", "type", "env_key", "inject_env"])
      .where("project_id", "=", projectId)
      .execute();

    const taken = new Set(
      siblings.filter((row) => row.inject_env === 1).map((row) => serviceEnvKey(row))
    );
    if (taken.has(connectionEnvKey(type))) {
      const suggested = suggestEnvKey(name, type);
      envKey = taken.has(suggested) ? `${suggested}_2` : suggested;
    }
  }

  const config = { name, type, version, port, credentials, projectSlug };
  let provisioned = false;

  // Restricting at creation costs nothing to undo and saves a service from ever
  // having been open, which is not something that can be taken back afterwards.
  const restricted = access?.mode === "restricted";
  const accessRow: AccessRow = {
    access_mode: restricted ? "restricted" : "open",
    access_allow: JSON.stringify(access?.allow ?? []),
    access_port: restricted ? await allocateLoopbackPort() : null,
  };

  try {
    const containerId = await provisionService(config, projectSlug, accessRow);
    provisioned = true;
    const connString = getConnectionString(config);
    const now = nowIso();

    await db
      .insertInto("services")
      .values({
        id,
        name,
        type,
        version,
        status: "running",
        container_id: containerId,
        port,
        credentials: encrypt(JSON.stringify({ ...credentials, connectionString: connString })),
        container_name: containerName,
        config: JSON.stringify({}),
        project_id: projectId || null,
        // Attaching a database to a project is the act of asking for its URL:
        // a new link starts on. A standalone service has nowhere to inject.
        inject_env: projectId ? 1 : 0,
        // Null means "derive it from the type". Only a collision makes it worth
        // naming, and there cannot be one on a service that was just created
        // unless another link already claims the same key — checked below.
        env_key: envKey,
        access_mode: accessRow.access_mode,
        access_allow: accessRow.access_allow,
        access_port: accessRow.access_port,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // After the container: it is now publishing on loopback, so the public port
    // is free for the gate to take.
    await syncGate("service", id, accessRow, { publicPort: port, label: name });

    const service = await db
      .selectFrom("services")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return NextResponse.json(service, { status: 201 });
  } catch (err: unknown) {
    // A container that exists with no row behind it is invisible to the panel
    // and, for a service with no project, to the orphan scanner as well — it
    // would sit there holding a port forever. If the insert is what failed,
    // take the container back down.
    if (provisioned) {
      try {
        await removeService(containerName);
      } catch { /* the original error is the one worth reporting */ }
    }

    const message = err instanceof Error ? err.message : "Provisioning failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
