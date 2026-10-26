import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { setSetting } from "@/lib/settings";
import { acmeEmailSchema } from "@/lib/validation";
import { ACME_EMAIL_SETTING } from "@/services/proxy";

/** The address Let's Encrypt writes to before a certificate expires. Empty is allowed. */
export async function PUT(request: NextRequest) {
  return withAudit(request, { category: "config", action: "domain.settings", scope: "permission", scopeId: "host" }, async () => {
    const denied = await requirePermission("host");
    if (isDenied(denied)) return denied;

    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = acmeEmailSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    await setSetting(ACME_EMAIL_SETTING, parsed.data.acmeEmail);
    return NextResponse.json({ acmeEmail: parsed.data.acmeEmail });
  });
}
