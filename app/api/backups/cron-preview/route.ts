import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { describeCron, nextOccurrences } from "@/lib/cron";
import { getSetting } from "@/lib/settings";
import { cronPreviewSchema } from "@/lib/validation";

/**
 * What an expression actually means, while it is being typed.
 *
 * Answered by the same parser the scheduler uses, so the preview and the
 * behaviour cannot disagree — which is the failure mode a client-side
 * approximation would have.
 */
export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  // A malformed body is a bad request, not a 500.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const parsed = cronPreviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Espressione non valida" },
      { status: 400 }
    );
  }

  const { cron, count } = parsed.data;
  const timezone = parsed.data.timezone ?? (await getSetting("timezone")) ?? "UTC";

  return NextResponse.json({
    description: describeCron(cron),
    timezone,
    occurrences: nextOccurrences(cron, new Date(), timezone, count ?? 3).map((date) =>
      date.toISOString()
    ),
  });
}
