import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { canEditUser, projectAccess, serviceAccess } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { projectRef, serviceRef } from "@/lib/principal";
import { getUserAccess } from "@/lib/users";

/**
 * Who reaches one project or service, and how — the "Chi ha accesso" panel.
 *
 * Computed with the same functions the guards use, so what it says is what
 * the routes do. For whoever manages users; the target must exist.
 */
export async function GET(request: NextRequest) {
  const denied = await requirePermission("users.manage");
  if (isDenied(denied)) return denied;

  const kind = request.nextUrl.searchParams.get("kind");
  const id = request.nextUrl.searchParams.get("id") ?? "";
  const projectTarget = kind === "project" ? await projectRef(id) : null;
  const serviceTarget = kind === "service" ? await serviceRef(id) : null;
  if (!projectTarget && !serviceTarget) return NextResponse.json({ error: "Elemento non trovato" }, { status: 404 });

  const db = await getDb();
  const users = await db.selectFrom("users").select(["id", "email", "is_owner", "disabled"]).orderBy("created_at").execute();

  const rows = [];
  for (const user of users) {
    const isOwner = user.is_owner === 1;
    const access = isOwner ? { permissions: [], grants: [] } : await getUserAccess(user.id);
    const principal = { userId: user.id, isOwner, permissions: new Set(access.permissions), grants: access.grants };
    const effective = projectTarget ? projectAccess(principal, projectTarget) : serviceAccess(principal, serviceTarget!);
    if (effective.level === null) continue;
    const direct = access.grants.find((g) => g.scope === kind && g.scopeId === id) ?? null;
    rows.push({
      id: user.id,
      email: user.email,
      isOwner,
      disabled: user.disabled === 1,
      level: effective.level,
      terminal: effective.terminal,
      direct,
      editable: canEditUser(denied.principal, { isOwner, userId: user.id, access }),
    });
  }
  return NextResponse.json({ users: rows }, { headers: { "Cache-Control": "no-store" } });
}
