import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { generateId, slugify } from "@/lib/utils";
import { createProjectSchema } from "@/lib/validation";
import crypto from "crypto";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const db = await getDb();

    const projects = await db
      .selectFrom("projects")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();

    // Deployment stats in one grouped pass rather than two correlated
    // subqueries per project. `count` comes back as a string on Postgres and a
    // number on SQLite, so normalise it.
    const stats = await db
      .selectFrom("deployments")
      .select(["project_id"])
      .select((eb) => [
        eb.fn.count("id").as("deploy_count"),
        eb.fn.max("started_at").as("last_deploy_at"),
      ])
      .groupBy("project_id")
      .execute();

    const statsByProject = new Map(
      stats.map((s) => [
        s.project_id,
        { deploy_count: Number(s.deploy_count), last_deploy_at: s.last_deploy_at },
      ])
    );

    // Batch load all services (avoids N+1)
    const allServices = await db
      .selectFrom("services")
      .selectAll()
      .where("project_id", "is not", null)
      .execute();

    const servicesByProject = new Map<string, typeof allServices>();
    for (const svc of allServices) {
      const pid = svc.project_id;
      if (!pid) continue;
      const list = servicesByProject.get(pid);
      if (list) list.push(svc);
      else servicesByProject.set(pid, [svc]);
    }

    const result = projects.map((p) => ({
      ...p,
      deploy_count: statsByProject.get(p.id)?.deploy_count ?? 0,
      last_deploy_at: statsByProject.get(p.id)?.last_deploy_at ?? null,
      services: servicesByProject.get(p.id) ?? [],
    }));

    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error("[api/projects] Error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to load projects" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const body = await request.json();
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { name } = parsed.data;
  const id = generateId();
  const slug = slugify(name);

  const db = await getDb();

  const existing = await db
    .selectFrom("projects")
    .select("id")
    .where("slug", "=", slug)
    .executeTakeFirst();

  if (existing) {
    return NextResponse.json(
      { error: `A project with slug "${slug}" already exists` },
      { status: 409 }
    );
  }

  const now = nowIso();

  // A project starts as an empty container — the app and its services are
  // added afterwards.
  await db
    .insertInto("projects")
    .values({
      id,
      name,
      slug,
      app_name: null,
      source_type: "upload",
      source_url: null,
      source_branch: "main",
      runtime_type: "node",
      builder_config: "{}",
      port: null,
      status: "stopped",
      auto_deploy: 0,
      webhook_secret: crypto.randomBytes(20).toString("hex"),
      created_at: now,
      updated_at: now,
    })
    .execute();

  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  return NextResponse.json(project, { status: 201 });
}
