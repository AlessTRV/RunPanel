import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { hasPermission } from "@/lib/authz";
import { getDb, nowIso } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { generateId } from "@/lib/utils";
import { hostnameFor } from "@/lib/proxy-names";
import { PANEL_PUBLIC_URL_SETTING } from "@/lib/panel-url";
import { readAccess } from "@/lib/access-columns";
import { createHostSchema } from "@/lib/validation";
import {
  applyProxySoon,
  canApply,
  hostView,
  issueCertificate,
  newCheckToken,
  proxyProbe,
} from "@/services/proxy";

type Params = { params: Promise<{ projectId: string }> };

/** The project's names, plus what the section needs to offer a new one. */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "view");
  if (isDenied(denied)) return denied;

  const db = await getDb();
  const [project, hosts, domains, proxy] = await Promise.all([
    db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst(),
    db.selectFrom("project_hosts").selectAll().where("project_id", "=", projectId).orderBy("hostname", "asc").execute(),
    db.selectFrom("domains").select(["id", "name"]).orderBy("name", "asc").execute(),
    proxyProbe(),
  ]);
  if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

  return NextResponse.json({
    hosts: hosts.map(hostView),
    domains,
    proxy: { state: proxy.state, detail: proxy.detail },
    hasPort: project.port !== null,
    restricted: readAccess(project).mode === "restricted",
    // Whether to point at the Domains page or only say who can add a domain.
    canManageDomains: hasPermission(denied.principal, "host"),
  });
}

export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.host.add", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;

    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = createHostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    const db = await getDb();
    const project = await db.selectFrom("projects").select(["id", "port"]).where("id", "=", projectId).executeTakeFirst();
    if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
    if (!project.port) {
      return NextResponse.json(
        { error: "Il progetto non ha una porta: dagliene una prima di assegnargli un nome." },
        { status: 409 }
      );
    }

    const { domainId, subdomain, publicAccess } = parsed.data;
    const domain = await db.selectFrom("domains").select(["id", "name"]).where("id", "=", domainId).executeTakeFirst();
    if (!domain) return NextResponse.json({ error: "Dominio non trovato" }, { status: 404 });

    const hostname = hostnameFor(subdomain, domain.name);
    if (!hostname) {
      return NextResponse.json({ error: "Il nome completo supera la lunghezza che il DNS consente." }, { status: 400 });
    }

    // Which project holds it is not said: it may be one this account cannot see.
    if (await db.selectFrom("project_hosts").select("id").where("hostname", "=", hostname).executeTakeFirst()) {
      return NextResponse.json({ error: `${hostname} è già assegnato.` }, { status: 409 });
    }
    const panelUrl = await getSetting(PANEL_PUBLIC_URL_SETTING);
    if (panelUrl && URL.canParse(panelUrl) && new URL(panelUrl).hostname.toLowerCase() === hostname) {
      return NextResponse.json({ error: `${hostname} è l'indirizzo del pannello.` }, { status: 409 });
    }

    const now = nowIso();
    const row = {
      id: generateId(),
      project_id: projectId,
      domain_id: domain.id,
      subdomain,
      hostname,
      public_access: publicAccess ? 1 : 0,
      check_token: newCheckToken(),
      status: "pending" as const,
      last_error: null,
      apply_error: null,
      cert_expires_at: null,
      created_at: now,
      updated_at: now,
    };
    await db.insertInto("project_hosts").values(row).execute();

    // The certificate takes seconds to a minute: asked for in the background,
    // and the section follows `status`. Without certbot the name is at least
    // served over HTTP; without nginx it waits until the Domains page is done.
    const found = await proxyProbe();
    if (found.state === "ready") issueCertificate(row.id);
    else if (canApply(found)) applyProxySoon();

    return NextResponse.json({ host: hostView(row), proxy: { state: found.state, detail: found.detail } }, { status: 201 });
  });
}
