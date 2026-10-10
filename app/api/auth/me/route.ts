import { NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { GLOBAL_PERMISSIONS, hasPermission } from "@/lib/authz";

/**
 * Who is signed in and what the interface should offer them.
 *
 * Cosmetic only: the pages hide what this says is not theirs, but every route
 * still checks for itself. Answers for the migrated owner without an email too,
 * so the layout can send them to the page that asks for one.
 */
export async function GET() {
  const ctx = await requireUser({ allowMissingEmail: true });
  if (isDenied(ctx)) return ctx;

  const { session, principal } = ctx;
  return NextResponse.json(
    {
      user: { id: session.user.id, email: session.user.email, isOwner: session.user.isOwner },
      emailRequired: session.user.email === null,
      permissions: GLOBAL_PERMISSIONS.filter((p) => hasPermission(principal, p)),
      grants: principal.grants,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
