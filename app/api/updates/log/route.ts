import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { logPathFor, readLogFile } from "@/services/log-file";
import { currentRun, updateLogDir } from "@/services/panel-update/run";

/** The tail kept for a finished run. A full build is tens of thousands of lines. */
const TAIL_LINES = 2000;

/**
 * The log of a run that is over.
 *
 * Separate from the stream, and not merely a convenience. `EventSource`
 * reconnects on its own — that is most of why the panel uses SSE at all — so a
 * stream that replays a finished log and then closes would be reopened, replay,
 * and close again, forever. The live case belongs to the stream; a finished one
 * is a document, and this hands it over once.
 */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const run = currentRun();
  if (!run) {
    return NextResponse.json({ runId: null, lines: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const text = readLogFile(logPathFor(updateLogDir(), run.runId), TAIL_LINES);

  return NextResponse.json(
    { runId: run.runId, lines: text.split("\n").filter((line) => line.length > 0) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
