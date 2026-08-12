import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { opsEvents, type OpsEvent } from "@/services/events";
import { readLogFile } from "@/services/log-file";
import { assertBackupId, backupLogPath } from "@/services/backup/paths";

type Params = { params: Promise<{ runId: string }> };

/**
 * The live log of one backup run, as Server-Sent Events.
 *
 * Same shape as the project stream: replay what already happened, then follow.
 * A backup can run for a quarter of an hour, and a page opened halfway through
 * that showed nothing until the next line would look broken.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { runId } = await params;
  try {
    assertBackupId(runId);
  } catch {
    return new Response("Backup non trovato", { status: 404 });
  }

  const db = await getDb();
  const run = await db
    .selectFrom("backup_runs")
    .select(["id", "status"])
    .where("id", "=", runId)
    .executeTakeFirst();

  if (!run) return new Response("Backup non trovato", { status: 404 });

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: OpsEvent | Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed by the client going away */
        }
      };

      send({ type: "ready", runId, status: run.status });

      for (const line of readLogFile(backupLogPath(runId)).split("\n")) {
        if (line) send({ type: "backup:log", line });
      }

      // A finished run has nothing more to say; close rather than hold a
      // connection open forever for a page someone left in a tab.
      if (run.status !== "running") {
        send({ type: "backup:status", status: run.status });
        cleanup();
        return;
      }

      unsubscribe = opsEvents.subscribe(runId, send);

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, 25_000);

      request.signal.addEventListener("abort", cleanup);
    },

    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
