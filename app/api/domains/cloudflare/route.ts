import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { cloudflareTokenSchema } from "@/lib/validation";
import { syncCloudflare } from "@/services/proxy";
import { forgetCloudflareToken, listZones, saveCloudflareToken } from "@/services/proxy/cloudflare";

/**
 * The Cloudflare API token behind the domains whose DNS is there.
 *
 * Tried by listing the zones before it is kept, so a token that cannot do the
 * job is refused here, with Cloudflare's reason, rather than at the first
 * certificate. Behind `host` like the rest of the Domains page: whoever holds
 * the token can rewrite the DNS of every zone it reaches.
 */
export async function PUT(request: NextRequest) {
  return withAudit(request, { category: "config", action: "domain.cloudflare.connect", scope: "permission", scopeId: "host" }, async () => {
    const denied = await requirePermission("host");
    if (isDenied(denied)) return denied;

    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = cloudflareTokenSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    let zones;
    try {
      zones = await listZones(parsed.data.token);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }

    await saveCloudflareToken(parsed.data.token, zones);
    return NextResponse.json({ cloudflare: await syncCloudflare() });
  });
}

/** The certificates already issued stay; at renewal their names go back to port 80. */
export async function DELETE(request: NextRequest) {
  return withAudit(request, { category: "config", action: "domain.cloudflare.disconnect", scope: "permission", scopeId: "host" }, async () => {
    const denied = await requirePermission("host");
    if (isDenied(denied)) return denied;

    await forgetCloudflareToken();
    return NextResponse.json({ cloudflare: await syncCloudflare() });
  });
}
