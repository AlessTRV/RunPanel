import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { listSessions, revokeSession } from "@/lib/auth";
import { canEditUser, type Principal } from "@/lib/authz";
import { getUserAccess } from "@/lib/users";
import { getDb } from "@/lib/db";

/**
 * Devices currently signed in. Tokens are stored hashed and never returned.
 *
 * Everyone sees their own. `?userId=` lists another account's, for the owner
 * and for whoever holds `users.manage` — never the owner's, which only the
 * owner sees.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireUser({ allowMissingEmail: true });
  if (isDenied(ctx)) return ctx;

  const target = request.nextUrl.searchParams.get("userId") ?? ctx.session.user.id;
  if (!(await mayManageSessionsOf(ctx.principal, target))) {
    return NextResponse.json({ error: "Non hai il permesso per questa operazione" }, { status: 403 });
  }

  const sessions = await listSessions(target);
  return NextResponse.json(
    { sessions: sessions.map((s) => ({ ...s, current: s.id === ctx.session.sessionId })) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** Revoke one device. */
export async function DELETE(request: NextRequest) {
  const ctx = await requireUser({ allowMissingEmail: true });
  if (isDenied(ctx)) return ctx;

  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Serve il parametro id" }, { status: 400 });
  }

  const db = await getDb();
  const row = await db.selectFrom("sessions").select("user_id").where("id", "=", id).executeTakeFirst();
  // An unknown id and someone else's session answer alike.
  if (!row?.user_id || !(await mayManageSessionsOf(ctx.principal, row.user_id))) {
    return NextResponse.json({ error: "Sessione non trovata" }, { status: 404 });
  }

  await revokeSession(id);
  await audit({ userId: ctx.session.user.id, category: "security", action: "session.revoke", scope: "user", scopeId: row.user_id, request });
  return NextResponse.json({ success: true, sessions: await listSessions(row.user_id) });
}

async function mayManageSessionsOf(principal: Principal, userId: string): Promise<boolean> {
  if (userId === principal.userId || principal.isOwner) return true;
  const db = await getDb();
  const target = await db.selectFrom("users").select("is_owner").where("id", "=", userId).executeTakeFirst();
  if (!target) return false;
  return canEditUser(principal, { isOwner: target.is_owner === 1, userId, access: await getUserAccess(userId) });
}
