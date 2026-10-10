import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { canEditUser } from "@/lib/authz";
import { reinviteSchema } from "@/lib/users-schema";
import { clampInviteHours, getUser, getUserAccess, issueInvite } from "@/lib/users";

type Params = { params: Promise<{ userId: string }> };

/**
 * A fresh link for an account: a new invitation while it has no password, a
 * reset once it has one. Any unused link of that account stops working.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requirePermission("users.manage");
  if (isDenied(denied)) return denied;
  const { userId } = await params;

  const target = await getUser(userId);
  if (!target) return NextResponse.json({ error: "Utente non trovato" }, { status: 404 });
  if (!canEditUser(denied.principal, { isOwner: target.is_owner === 1, userId, access: await getUserAccess(userId) })) {
    return NextResponse.json({ error: "Questo account non è modificabile da te" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = reinviteSchema.safeParse(body);
  const hours = parsed.success ? clampInviteHours(parsed.data.hours) : null;
  if (!hours) return NextResponse.json({ error: "Durata del link non valida (da 1 ora a 30 giorni)" }, { status: 400 });

  const kind = target.password_hash ? "reset" : "invite";
  const invite = await issueInvite(userId, kind, hours, denied.session.user.id);
  await audit({ userId: denied.session.user.id, category: "security", action: `user.${kind}`, scope: "user", scopeId: userId, detail: `${hours}h`, request });
  return NextResponse.json(
    { kind, invitePath: `/invite/${invite.token}`, expiresAt: invite.expiresAt },
    { headers: { "Cache-Control": "no-store" } }
  );
}
