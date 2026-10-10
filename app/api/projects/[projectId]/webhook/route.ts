import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { hasPermission } from "@/lib/authz";
import { withAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { webhookActionSchema } from "@/lib/validation";
import { webhookStatus } from "@/services/webhook-status";
import { connectWebhook, disconnectWebhook, pingWebhook } from "@/services/webhook-manage";

/**
 * The panel's own view of a project's webhook, and the three things it can do
 * about it.
 *
 * Deliberately NOT under `/api/webhooks/` — that prefix is excluded from the
 * session gate in `proxy.ts` because GitHub has to reach it unauthenticated,
 * and a route that reads a project's secret and writes to the operator's GitHub
 * account must not inherit that exemption by living next door to it.
 */

type Params = { params: Promise<{ projectId: string }> };

async function loadProject(projectId: string) {
  const db = await getDb();
  return db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();
}

export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "webhook");
  if (isDenied(denied)) return denied;
  const project = await loadProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  const status = await webhookStatus(project, request);
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.webhook", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "webhook");
    if (isDenied(denied)) return denied;
    // Creating or changing a GitHub webhook acts with the panel's token.
    if (!hasPermission(denied.principal, "github")) {
      return NextResponse.json({ error: "Serve il permesso GitHub" }, { status: 403 });
    }

    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }

    const parsed = webhookActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Azione non valida", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const project = await loadProject(projectId);
    if (!project) {
      return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
    }

    const { action } = parsed.data;

    const result =
      action === "connect"
        ? await connectWebhook(project, request)
        : action === "ping"
          ? await pingWebhook(project)
          : await disconnectWebhook(project);

    // The status is recomputed either way, so the caller re-renders from one
    // answer rather than firing a follow-up GET that races the write it just did.
    const status = await webhookStatus(await loadProject(projectId) ?? project, request);

    if (!result.ok) {
      return NextResponse.json({ error: result.message, status }, { status: 400 });
    }

    return NextResponse.json({ ok: true, message: result.message, status });
  });
}
