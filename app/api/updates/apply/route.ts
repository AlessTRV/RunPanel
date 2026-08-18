import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { isCommitSha } from "@/lib/git-ref";
import { probeAutostart } from "@/services/autostart/probe";
import {
  PanelUpdateBusyError,
  canSelfUpdate,
  dismissRun,
  startPanelUpdate,
  updateBlockers,
} from "@/services/panel-update/run";

/**
 * Start the update, and answer before it can possibly finish.
 *
 * 202 with the run id, the same shape `POST /api/backups/policies/[id]/run`
 * uses — and here it is not a nicety. The run ends by exiting the process that
 * would have sent the response, so the response has to be long gone by then.
 */
export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  let body: { expectedSha?: unknown } = {};
  try {
    body = (await request.json()) as { expectedSha?: unknown };
  } catch {
    // An empty body is fine: `expectedSha` only sharpens a log line.
  }

  let expectedSha: string | null = null;
  if (typeof body.expectedSha === "string" && body.expectedSha) {
    // Never hand git a string somebody else chose. The rule and the reason are
    // in `lib/git-ref.ts`; this value only ever gets compared, but the day it
    // gets interpolated is not the day to start checking.
    if (!isCommitSha(body.expectedSha)) {
      return NextResponse.json({ error: "SHA non valido" }, { status: 400 });
    }
    expectedSha = body.expectedSha;
  }

  const probe = await probeAutostart();
  const verdict = canSelfUpdate(probe, process.platform, process.env.NODE_ENV);
  if (!verdict.ok && verdict.restart !== "manual") {
    return NextResponse.json({ error: verdict.reason }, { status: 409 });
  }

  const blocker = await updateBlockers();
  if (blocker) {
    return NextResponse.json({ error: blocker.reason }, { status: 409 });
  }

  try {
    // A previous run's outcome is history the moment a new one starts; leaving
    // it would make the page show two runs at once.
    dismissRun();
    const { runId } = await startPanelUpdate({ expectedSha });
    return NextResponse.json({ runId }, { status: 202 });
  } catch (err) {
    if (err instanceof PanelUpdateBusyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
