import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { isDenied, requireMember } from "@/lib/auth-guard";
import { installSecret } from "@/services/cluster/state";

const bodySchema = z.object({ secret: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

/**
 * A panel is rotating the shared secret. The request itself is signed with
 * the secret being retired, which stays valid for a grace period so members
 * that hear late are not cut off mid-request.
 */
export async function POST(request: NextRequest) {
  const denied = await requireMember({ role: "panel" });
  if (isDenied(denied)) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Dati non validi" }, { status: 400 });

  await installSecret(parsed.data.secret);
  await audit({ userId: null, category: "security", action: "cluster.secret.rotate", detail: `da ${denied.member.name}` });
  return NextResponse.json({ success: true });
}
