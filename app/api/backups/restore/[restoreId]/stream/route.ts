import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { opsEvents, type OpsEvent } from "@/services/events";
import { readLogFile } from "@/services/log-file";
import { assertBackupId, restoreLogPath } from "@/services/backup/paths";

type Params = { params: Promise<{ restoreId: string }> };

/** The live log of one restore. Same contract as the backup stream. */
export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { restoreId } = await params;
  try {
    assertBackupId(restoreId);
  } catch {
    return new Response("Ripristino non trovato", { status: 404 });
  }

  const db = await getDb();
  const restore = await db
    .selectFrom("restore_runs")
    .select(["id", "status"])
    .where("id", "=", restoreId)
    .executeTakeFirst();

  if (!restore) return new Response("Ripristino non trovato", { status: 404 });

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

      send({ type: "ready", restoreId, status: restore.status });

      for (const line of readLogFile(restoreLogPath(restoreId)).split("\n")) {
        if (line) send({ type: "restore:log", line });
      }

      if (restore.status !== "running") {
        send({ type: "restore:status", status: restore.status });
        cleanup();
        return;
      }

      unsubscribe = opsEvents.subscribe(restoreId, send);

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
