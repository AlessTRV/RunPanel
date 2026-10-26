import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { hostActionSchema, updateHostSchema } from "@/lib/validation";
import {
  applyProxy,
  applyProxySoon,
  forgetCertificate,
  hostView,
  isIssuing,
  issueCertificate,
  proxyProbe,
} from "@/services/proxy";

type Params = { params: Promise<{ projectId: string; hostId: string }> };

/** The name, only if it belongs to this project — another project's id answers like a missing one. */
async function findHost(projectId: string, hostId: string) {
  const db = await getDb();
  return db
    .selectFrom("project_hosts")
    .selectAll()
    .where("id", "=", hostId)
    .where("project_id", "=", projectId)
    .executeTakeFirst();
}

async function readBody(request: NextRequest): Promise<unknown | NextResponse> {
  try {
    return await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
}

/** Open the name to everyone while the port stays restricted, or make it follow the port again. */
export async function PATCH(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.host.update", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId, hostId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;

    const body = await readBody(request);
    if (body instanceof NextResponse) return body;
    const parsed = updateHostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    const host = await findHost(projectId, hostId);
    if (!host) return NextResponse.json({ error: "Nome non trovato" }, { status: 404 });

    const db = await getDb();
    const public_access = parsed.data.publicAccess ? 1 : 0;
    await db.updateTable("project_hosts").set({ public_access, updated_at: nowIso() }).where("id", "=", hostId).execute();
    applyProxySoon();

    return NextResponse.json({ host: hostView({ ...host, public_access }) });
  });
}

/** Ask for the certificate again, after fixing what the last attempt reported. */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.host.retry", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId, hostId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;

    const body = await readBody(request);
    if (body instanceof NextResponse) return body;
    if (!hostActionSchema.safeParse(body).success) {
      return NextResponse.json({ error: "Azione non valida" }, { status: 400 });
    }

    const host = await findHost(projectId, hostId);
    if (!host) return NextResponse.json({ error: "Nome non trovato" }, { status: 404 });

    const found = await proxyProbe(true);
    if (found.state !== "ready") return NextResponse.json({ error: found.detail }, { status: 409 });
    if (!isIssuing(hostId)) issueCertificate(hostId);

    return NextResponse.json({ host: hostView({ ...host, status: "issuing" }) }, { status: 202 });
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.host.remove", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId, hostId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;

    const host = await findHost(projectId, hostId);
    if (!host) return NextResponse.json({ error: "Nome non trovato" }, { status: 404 });

    const db = await getDb();
    await db.deleteFrom("project_hosts").where("id", "=", hostId).execute();

    // The block goes first; its certificate only once nothing refers to it.
    void applyProxy().then(() => forgetCertificate(host.hostname));

    return NextResponse.json({ success: true });
  });
}
