import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { canEditUser, grantableProblem } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { updateUserSchema } from "@/lib/users-schema";
import { deleteUser, getUser, getUserAccess, listUsers, setUserAccess, setUserDisabled } from "@/lib/users";

type Params = { params: Promise<{ userId: string }> };

const notFound = () => NextResponse.json({ error: "Utente non trovato" }, { status: 404 });

/** One account and its access. The owner's is shown, never editable. */
export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requirePermission("users.manage");
  if (isDenied(denied)) return denied;
  const { userId } = await params;

  const summary = (await listUsers()).find((u) => u.id === userId);
  if (!summary) return notFound();
  const access = summary.isOwner ? null : await getUserAccess(userId);
  return NextResponse.json(
    {
      user: summary,
      access,
      editable: canEditUser(denied.principal, { isOwner: summary.isOwner, userId, access: access ?? undefined }),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** Replace the access of an account, or disable / re-enable it. */
export async function PATCH(request: NextRequest, { params }: Params) {
  const denied = await requirePermission("users.manage");
  if (isDenied(denied)) return denied;
  const { userId } = await params;

  const target = await getUser(userId);
  if (!target) return notFound();
  if (!canEditUser(denied.principal, { isOwner: target.is_owner === 1, userId, access: await getUserAccess(userId) })) {
    return NextResponse.json({ error: "Questo account non è modificabile da te" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
  }

  if (parsed.data.access) {
    const { permissions, grants } = parsed.data.access;
    const problem = grantableProblem(denied.principal, permissions, grants);
    if (problem) return NextResponse.json({ error: problem }, { status: 403 });

    // A grant on something that does not exist would sit there and apply to
    // nothing — refuse it, so the page shows the mistake instead.
    const missing = await missingTarget(grants);
    if (missing) return NextResponse.json({ error: `Destinazione non trovata: ${missing}` }, { status: 400 });

    await setUserAccess(userId, { permissions, grants });
    await audit({
      userId: denied.session.user.id,
      category: "security",
      action: "user.access",
      scope: "user",
      scopeId: userId,
      detail: `${permissions.length} permessi, ${grants.length} accessi`,
      request,
    });
  }

  if (parsed.data.disabled !== undefined) {
    await setUserDisabled(userId, parsed.data.disabled);
    await audit({
      userId: denied.session.user.id,
      category: "security",
      action: parsed.data.disabled ? "user.disable" : "user.enable",
      scope: "user",
      scopeId: userId,
      request,
    });
  }

  return NextResponse.json({ success: true, access: await getUserAccess(userId) });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const denied = await requirePermission("users.manage");
  if (isDenied(denied)) return denied;
  const { userId } = await params;

  const target = await getUser(userId);
  if (!target) return notFound();
  if (!canEditUser(denied.principal, { isOwner: target.is_owner === 1, userId, access: await getUserAccess(userId) })) {
    return NextResponse.json({ error: "Questo account non è eliminabile da te" }, { status: 403 });
  }
  await deleteUser(userId);
  await audit({ userId: denied.session.user.id, category: "security", action: "user.delete", scope: "user", scopeId: userId, detail: target.email, request });
  return NextResponse.json({ success: true });
}

async function missingTarget(grants: ReadonlyArray<{ scope: string; scopeId: string | null }>): Promise<string | null> {
  const db = await getDb();
  const tables = { folder: "folders", project: "projects", service: "services" } as const;
  for (const grant of grants) {
    if (grant.scope === "all" || !grant.scopeId) continue;
    const table = tables[grant.scope as keyof typeof tables];
    const row = await db.selectFrom(table).select("id").where("id", "=", grant.scopeId).executeTakeFirst();
    if (!row) return `${grant.scope} ${grant.scopeId}`;
  }
  return null;
}
