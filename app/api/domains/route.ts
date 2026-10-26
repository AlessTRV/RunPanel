import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { generateId } from "@/lib/utils";
import { createDomainSchema } from "@/lib/validation";
import { isVisible, visibleProjectIds } from "@/lib/principal";
import { ACME_EMAIL_SETTING, hostView, proxyProbe, publicAddresses, syncCloudflare } from "@/services/proxy";

/**
 * The Domains page: what this server's nginx can do, the domains it answers
 * for, and every name assigned under them.
 *
 * Behind `host`: setting up a domain writes into the configuration of an nginx
 * that serves the whole machine. Assigning a name to a project is the
 * project's own business, under `/api/projects/:id/hosts`.
 */
export async function GET(request: NextRequest) {
  const denied = await requirePermission("host");
  if (isDenied(denied)) return denied;

  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  // First, because it may link or unlink a domain, and the list below should say so.
  const cloudflare = await syncCloudflare(fresh);
  const db = await getDb();
  const [proxy, acmeEmail, domains, hosts, visible] = await Promise.all([
    proxyProbe(fresh),
    getSetting(ACME_EMAIL_SETTING),
    db.selectFrom("domains").selectAll().orderBy("name", "asc").execute(),
    db
      .selectFrom("project_hosts")
      .innerJoin("projects", "projects.id", "project_hosts.project_id")
      .selectAll("project_hosts")
      .select("projects.name as project_name")
      .orderBy("project_hosts.hostname", "asc")
      .execute(),
    visibleProjectIds(denied.principal),
  ]);

  return NextResponse.json({
    proxy,
    acmeEmail: acmeEmail ?? "",
    addresses: publicAddresses(),
    cloudflare: {
      ...cloudflare,
      zones: cloudflare.zones.map((zone) => ({
        ...zone,
        domainId: domains.find((domain) => domain.name === zone.name)?.id ?? null,
      })),
    },
    domains: domains.map((domain) => ({
      ...domain,
      cloudflare: domain.cloudflare === 1,
      // Every name, visible or not: it is what decides whether the domain can go.
      hostCount: hosts.filter((host) => host.domain_id === domain.id).length,
    })),
    hosts: hosts.filter((host) => isVisible(visible, host.project_id)).map(hostView),
  });
}

export async function POST(request: NextRequest) {
  return withAudit(request, { category: "config", action: "domain.create", scope: "permission", scopeId: "host" }, async () => {
    const denied = await requirePermission("host");
    if (isDenied(denied)) return denied;

    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = createDomainSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    const { name } = parsed.data;
    const db = await getDb();
    if (await db.selectFrom("domains").select("id").where("name", "=", name).executeTakeFirst()) {
      return NextResponse.json({ error: `Il dominio ${name} c'è già.` }, { status: 409 });
    }

    const now = nowIso();
    const domain = { id: generateId(), name, cloudflare: 0, created_at: now, updated_at: now };
    await db.insertInto("domains").values(domain).execute();

    // On the Cloudflare account it is linked now, so even its first certificate goes through DNS.
    await syncCloudflare();
    const linked = await db.selectFrom("domains").select("cloudflare").where("id", "=", domain.id).executeTakeFirst();
    return NextResponse.json({ ...domain, cloudflare: linked?.cloudflare === 1, hostCount: 0 }, { status: 201 });
  });
}
