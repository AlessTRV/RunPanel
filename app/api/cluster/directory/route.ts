import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireMember } from "@/lib/auth-guard";
import { directorySchema } from "@/lib/cluster-schema";
import { applySnapshot } from "@/services/cluster/directory";
import { recordMemberSeen } from "@/services/cluster/state";

/** The body a panel may push: every member's directory, at most a few MB. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Another member sends its copy of the directory; ours is merged with it and
 * the result is sent back, so one round trip converges both sides. Nodes push
 * too: a grant edited through a panel on a project they hold is written there.
 */
export async function POST(request: NextRequest) {
  const denied = await requireMember();
  if (isDenied(denied)) return denied;

  if (Number.parseInt(request.headers.get("content-length") ?? "0", 10) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Richiesta troppo grande" }, { status: 413 });
  }
  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Richiesta troppo grande" }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = directorySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Directory non valida", details: parsed.error.issues }, { status: 400 });
  }

  await recordMemberSeen(denied.member.id, {});
  const applied = await applySnapshot(parsed.data);
  return NextResponse.json(applied.result, { headers: { "Cache-Control": "no-store" } });
}
