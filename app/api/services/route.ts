import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { createServiceSchema } from "@/lib/validation";
import { encrypt } from "@/lib/auth";
import {
  generateCredentials,
  provisionService,
  getConnectionString,
  removeService,
  serviceContainerName,
} from "@/services/service-provisioner";

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

  const body = await request.json();
  const parsed = createServiceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { name, type, version, port, projectId, credentials: customCreds } = parsed.data;
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

  const config = { name, type, version, port, credentials, projectSlug };
  let provisioned = false;

  try {
    const containerId = await provisionService(config, projectSlug);
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
        created_at: now,
        updated_at: now,
      })
      .execute();

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
