import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { queryAudit } from "@/lib/audit";
import { AUDIT_CATEGORIES, type AuditCategory, type AuditScope } from "@/lib/audit-filter";

const SCOPES: readonly AuditScope[] = ["project", "service", "folder", "user", "permission"];
const isIso = (v: string | null): v is string => v !== null && !Number.isNaN(Date.parse(v));

/**
 * A page of the activity log. Holding `audit.view` opens the page; which
 * entries come back is decided one by one (lib/audit-filter.ts).
 */
export async function GET(request: NextRequest) {
  const denied = await requirePermission("audit.view");
  if (isDenied(denied)) return denied;

  const sp = request.nextUrl.searchParams;
  const category = sp.get("category");
  const scope = sp.get("scope");
  const limit = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));

  const result = await queryAudit(denied.principal, {
    userId: sp.get("userId") || undefined,
    category: category && (AUDIT_CATEGORIES as readonly string[]).includes(category) ? (category as AuditCategory) : undefined,
    action: sp.get("action")?.slice(0, 64) || undefined,
    scope: scope && (SCOPES as readonly string[]).includes(scope) ? (scope as AuditScope) : undefined,
    scopeId: sp.get("scopeId")?.slice(0, 64) || undefined,
    from: isIso(sp.get("from")) ? new Date(sp.get("from")!).toISOString() : undefined,
    to: isIso(sp.get("to")) ? new Date(sp.get("to")!).toISOString() : undefined,
    before: isIso(sp.get("before")) ? sp.get("before")! : undefined,
    limit,
  });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
