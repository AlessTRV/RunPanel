import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/auth";
import { envVarsSchema } from "@/lib/validation";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const reveal = request.nextUrl.searchParams.get("reveal") === "true";

  const db = getDb();
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const rows = db.prepare(
    "SELECT id, key, value FROM env_vars WHERE project_id = ? ORDER BY key"
  ).all(projectId) as { id: number; key: string; value: string }[];

  const vars = rows.map((row) => ({
    id: row.id,
    key: row.key,
    value: reveal ? decrypt(row.value) : "••••••••",
  }));

  return NextResponse.json(vars);
}

export async function PUT(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { projectId } = await params;
  const body = await request.json();
  const parsed = envVarsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const db = getDb();
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  db.transaction(() => {
    db.prepare("DELETE FROM env_vars WHERE project_id = ?").run(projectId);
    const insert = db.prepare(
      "INSERT INTO env_vars (project_id, key, value) VALUES (?, ?, ?)"
    );
    for (const v of parsed.data.vars) {
      insert.run(projectId, v.key, encrypt(v.value));
    }
  })();

  return NextResponse.json({ success: true, count: parsed.data.vars.length });
}
