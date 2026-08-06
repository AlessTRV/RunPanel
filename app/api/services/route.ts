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
      { error: "Validation failed", details: parsed.error.issues },
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

  try {
    // Get project slug for network linking
    let projectSlug: string | undefined;
    if (projectId) {
      const proj = await db
        .selectFrom("projects")
        .select("slug")
        .where("id", "=", projectId)
        .executeTakeFirst();
      projectSlug = proj?.slug;
    }

    const config = { name, type, version, port, credentials, projectSlug };
    const containerId = await provisionService(config, projectSlug);
    const connString = getConnectionString(config);
    const containerName = serviceContainerName(name, projectSlug);
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
        config: JSON.stringify({ containerName }),
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
    const message = err instanceof Error ? err.message : "Provisioning failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
