import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";

type Params = { params: Promise<{ domainId: string }> };

/**
 * A domain goes only once nothing uses it. Taking its names down with it would
 * be one press removing sites from projects this account may not even see.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "delete", action: "domain.delete", scope: "permission", scopeId: "host" }, async () => {
    const denied = await requirePermission("host");
    if (isDenied(denied)) return denied;

    const { domainId } = await params;
    const db = await getDb();
    const domain = await db.selectFrom("domains").selectAll().where("id", "=", domainId).executeTakeFirst();
    if (!domain) {
      return NextResponse.json({ error: "Dominio non trovato" }, { status: 404 });
    }

    const used = await db
      .selectFrom("project_hosts")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("domain_id", "=", domainId)
      .executeTakeFirst();
    const count = Number(used?.count ?? 0);
    if (count > 0) {
      return NextResponse.json(
        {
          error: `${domain.name} serve ancora ${count === 1 ? "un sottodominio" : `${count} sottodomini`}: toglili prima dai progetti.`,
        },
        { status: 409 }
      );
    }

    await db.deleteFrom("domains").where("id", "=", domainId).execute();
    return NextResponse.json({ success: true });
  });
}
