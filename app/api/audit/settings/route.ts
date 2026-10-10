import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORIES_SETTING,
  AUDIT_RETENTION_SETTING,
  parseEnabledCategories,
  parseRetentionDays,
  type AuditCategory,
} from "@/lib/audit-filter";
import { getSetting, setSetting } from "@/lib/settings";

const bodySchema = z
  .object({
    categories: z.array(z.enum(AUDIT_CATEGORIES as unknown as [AuditCategory, ...AuditCategory[]])).optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();

/** What the log records and for how long — the owner's call. */
export async function GET() {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;
  return NextResponse.json({
    categories: [...parseEnabledCategories(await getSetting(AUDIT_CATEGORIES_SETTING))],
    retentionDays: parseRetentionDays(await getSetting(AUDIT_RETENTION_SETTING)),
    alwaysOn: ["security"],
  });
}

export async function PUT(request: NextRequest) {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Dati non validi" }, { status: 400 });

  if (parsed.data.categories) {
    // `security` is stored too, so reading the setting back says what is recorded.
    const categories = [...new Set<AuditCategory>(["security", ...parsed.data.categories])];
    await setSetting(AUDIT_CATEGORIES_SETTING, JSON.stringify(categories));
  }
  if (parsed.data.retentionDays !== undefined) {
    await setSetting(AUDIT_RETENTION_SETTING, String(parsed.data.retentionDays));
  }

  // Changing what is recorded is itself recorded, and always.
  await audit({
    userId: denied.session.user.id,
    category: "security",
    action: "audit.settings",
    detail: JSON.stringify(parsed.data),
    request,
  });
  return NextResponse.json({ success: true });
}
