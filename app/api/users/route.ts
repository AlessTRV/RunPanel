import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { inviteSchema } from "@/lib/users-schema";
import { clampInviteHours, createInvitedUser, issueInvite, listUsers, normalizeEmail } from "@/lib/users";

/** Every account, for whoever manages users. */
export async function GET() {
  const denied = await requirePermission("users.manage");
  if (isDenied(denied)) return denied;
  return NextResponse.json({ users: await listUsers() }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Invite someone: an account with no password and no access, plus a one-time
 * link that lets them choose a password. The link is returned once, here, and
 * never again — only its hash is stored.
 */
export async function POST(request: NextRequest) {
  const denied = await requirePermission("users.manage");
  if (isDenied(denied)) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = inviteSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Dati non validi" }, { status: 400 });

  const email = normalizeEmail(parsed.data.email);
  if (!email) return NextResponse.json({ error: "Email non valida" }, { status: 400 });
  const hours = clampInviteHours(parsed.data.hours);
  if (!hours) return NextResponse.json({ error: "Durata del link non valida (da 1 ora a 30 giorni)" }, { status: 400 });

  const user = await createInvitedUser(email, denied.session.user.id);
  if (!user) return NextResponse.json({ error: "Esiste già un account con questa email" }, { status: 409 });

  const invite = await issueInvite(user.id, "invite", hours, denied.session.user.id);
  await audit({ userId: denied.session.user.id, category: "security", action: "user.invite", scope: "user", scopeId: user.id, detail: `${email}, ${hours}h`, request });
  return NextResponse.json(
    { user: { id: user.id, email }, invitePath: `/invite/${invite.token}`, expiresAt: invite.expiresAt },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
}
