import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { checkPanelUpdate } from "@/services/panel-update/check";

/**
 * Ask now instead of at the next tick.
 *
 * Answers 200 even when the check failed, with the reason in `error`. "I asked
 * github.com and it did not answer" is a successful check that found bad news,
 * not a broken endpoint, and a 500 here would put a red toast on the screen
 * instead of the sentence explaining what is wrong.
 */
export async function POST() {
  const denied = await requireAuth();
  if (denied) return denied;

  const result = await checkPanelUpdate();
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
