import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
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

  const db = getDb();
  const services = db.prepare("SELECT * FROM services ORDER BY created_at DESC").all();
  return NextResponse.json(services);
}

export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const body = await request.json();
  const parsed = createServiceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
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

  const db = getDb();

  try {
    // Get project slug for network linking
    let projectSlug: string | undefined;
    if (projectId) {
      const proj = db.prepare("SELECT slug FROM projects WHERE id = ?").get(projectId) as { slug: string } | undefined;
      projectSlug = proj?.slug;
    }

    const config = { name, type: type as "postgresql" | "mysql" | "redis" | "mongodb", version, port, credentials, projectSlug };
    const containerId = await provisionService(config, projectSlug);
    const connString = getConnectionString(config);
    const containerName = serviceContainerName(name, projectSlug);

    db.prepare(`
      INSERT INTO services (id, name, type, version, status, container_id, port, credentials, config, project_id)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      type,
      version,
      containerId,
      port,
      encrypt(JSON.stringify({ ...credentials, connectionString: connString })),
      JSON.stringify({ containerName }),
      projectId || null
    );

    const service = db.prepare("SELECT * FROM services WHERE id = ?").get(id);
    return NextResponse.json(service, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Provisioning failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
