import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { proxyActionSchema } from "@/lib/validation";
import { applyProxy, canApply, issuePending, proxyProbe, setUpProxy } from "@/services/proxy";

/**
 * `setup`  the one-time preparation of nginx — done here when the panel is
 *          root, answered with the commands to paste when it is not
 * `apply`  write every block again and reload, after the operator ran those
 *          commands or edited nginx by hand
 *
 * Both end by asking for the certificates of names that were assigned before
 * nginx could serve them.
 */
export async function POST(request: NextRequest) {
  return withAudit(request, { category: "system", action: "domain.proxy", scope: "permission", scopeId: "host" }, async () => {
    const denied = await requirePermission("host");
    if (isDenied(denied)) return denied;

    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = proxyActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    if (parsed.data.action === "setup") {
      const result = await setUpProxy();
      const requested = result.ok ? await issuePending() : 0;
      return NextResponse.json({ ...result, requested }, { status: result.ok || result.commands ? 200 : 409 });
    }

    const found = await proxyProbe(true);
    if (!canApply(found)) {
      return NextResponse.json({ ok: false, message: found.detail, commands: found.commands }, { status: 409 });
    }
    const result = await applyProxy();
    const requested = result.ok ? await issuePending() : 0;
    return NextResponse.json({ ...result, requested }, { status: result.ok ? 200 : 409 });
  });
}
