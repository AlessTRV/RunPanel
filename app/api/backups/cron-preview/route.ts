import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { describeCron, isValidTimeZone, nextOccurrences } from "@/lib/cron";
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
  const denied = await requireUser();
  if (isDenied(denied)) return denied;

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
  // The zone the scheduler will really use: a stored value that no longer
  // resolves is read as UTC there, so the preview must say UTC too.
  const stored = await getSetting("timezone");
  const timezone = parsed.data.timezone ?? (stored && isValidTimeZone(stored) ? stored : "UTC");

  return NextResponse.json({
    description: describeCron(cron),
    timezone,
    occurrences: nextOccurrences(cron, new Date(), timezone, count ?? 3).map((date) =>
      date.toISOString()
    ),
  });
}
