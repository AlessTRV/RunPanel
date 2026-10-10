import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { requireHostIfReaching } from "@/lib/host-guard";
import { withAudit } from "@/lib/audit";
import { PROJECT_ACTIONS, satisfies } from "@/lib/authz";
import { getDb, nowIso } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { generateId } from "@/lib/utils";
import { envVarsSchema } from "@/lib/validation";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "env.read");
  if (isDenied(denied)) return denied;
  // Values in clear only for whoever manages the project; everyone else gets
  // the keys with masked values, whatever the query string asks for.
  const reveal =
    request.nextUrl.searchParams.get("reveal") === "true" && satisfies(denied.access, PROJECT_ACTIONS["env.reveal"]);

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select("id")
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  const rows = await db
    .selectFrom("env_vars")
    .select(["id", "key", "value"])
    .where("project_id", "=", projectId)
    .orderBy("key")
    .execute();

  const vars = rows.map((row) => ({
    id: row.id,
    key: row.key,
    value: reveal ? decrypt(row.value) : "••••••••",
  }));

  // `?reveal=true` puts decrypted values in this body. Nothing between here and
  // the browser — a proxy, a service worker, the disk cache — should keep a copy.
  return NextResponse.json(vars, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.env", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "env.write");
    if (isDenied(denied)) return denied;
    const noHost = await requireHostIfReaching(denied.principal, projectId, "cambiare le variabili di un progetto che gira sull'host");
    if (noHost) return noHost;
    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = envVarsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const db = await getDb();
    const project = await db
      .selectFrom("projects")
      .select("id")
      .where("id", "=", projectId)
      .executeTakeFirst();

    if (!project) {
      return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
    }

    const now = nowIso();
    const rows = parsed.data.vars.map((v) => ({
      id: generateId(),
      project_id: projectId,
      key: v.key,
      value: encrypt(v.value),
      created_at: now,
    }));

    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("env_vars").where("project_id", "=", projectId).execute();
      if (rows.length > 0) {
        await trx.insertInto("env_vars").values(rows).execute();
      }
    });

    return NextResponse.json({ success: true, count: rows.length });
  });
}
