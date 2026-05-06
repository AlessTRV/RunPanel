import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { generateId, slugify } from "@/lib/utils";
import { createProjectSchema } from "@/lib/validation";
import { gitClone } from "@/services/git-manager";
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
  `).all();

  return NextResponse.json(projects);
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

  const { name, sourceType, sourceUrl, sourceBranch, runtimeType, port, builderConfig } = parsed.data;
  const id = generateId();
  const slug = slugify(name);

  const db = getDb();

  // Check slug uniqueness
  const existing = db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug);
  if (existing) {
    return NextResponse.json(
      { error: `A project with slug "${slug}" already exists` },
      { status: 409 }
    );
  }

  // Clone repo if GitHub source
  if (sourceType === "github" && sourceUrl) {
    try {
      await gitClone(sourceUrl, sourceBranch || "main", slug);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Clone failed";
      return NextResponse.json(
        { error: `Failed to clone repository: ${message}` },
        { status: 400 }
      );
    }
  }

  const webhookSecret = crypto.randomBytes(20).toString("hex");

  db.prepare(`
    INSERT INTO projects (id, name, slug, source_type, source_url, source_branch, runtime_type, builder_config, port, webhook_secret)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    slug,
    sourceType,
    sourceUrl || null,
    sourceBranch || "main",
    runtimeType,
    JSON.stringify(builderConfig || {}),
    port || null,
    webhookSecret
  );

  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  return NextResponse.json(project, { status: 201 });
}
