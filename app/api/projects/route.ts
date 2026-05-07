import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { generateId, slugify } from "@/lib/utils";
import { createProjectSchema } from "@/lib/validation";
import crypto from "crypto";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const db = getDb();
  const projects = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM deployments WHERE project_id = p.id) as deploy_count,
      (SELECT started_at FROM deployments WHERE project_id = p.id ORDER BY started_at DESC LIMIT 1) as last_deploy_at
    FROM projects p
    ORDER BY p.created_at DESC
  `).all() as Record<string, unknown>[];

  // Batch load all services (avoids N+1 query)
  const allServices = db.prepare("SELECT * FROM services WHERE project_id IS NOT NULL").all() as Record<string, unknown>[];
  const servicesByProject = new Map<string, Record<string, unknown>[]>();
  for (const svc of allServices) {
    const pid = svc.project_id as string;
    if (!servicesByProject.has(pid)) servicesByProject.set(pid, []);
    servicesByProject.get(pid)!.push(svc);
  }

  const result = projects.map((p) => ({
    ...p,
    services: servicesByProject.get(p.id as string) || [],
  }));

  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const body = await request.json();
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { name } = parsed.data;
  const id = generateId();
  const slug = slugify(name);

  const db = getDb();

  const existing = db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug);
  if (existing) {
    return NextResponse.json(
      { error: `A project with slug "${slug}" already exists` },
      { status: 409 }
    );
  }

  const webhookSecret = crypto.randomBytes(20).toString("hex");

  // Create project as empty container — app and services added separately
  db.prepare(`
    INSERT INTO projects (id, name, slug, source_type, runtime_type, webhook_secret)
    VALUES (?, ?, ?, 'upload', 'node', ?)
  `).run(id, name, slug, webhookSecret);

  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  return NextResponse.json(project, { status: 201 });
}
