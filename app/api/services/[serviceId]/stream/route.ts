import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { serviceEvents, type ServiceEvent } from "@/services/events";
import { consoleBacklog, consoleState, touchConsole } from "@/services/service-console";

type Params = { params: Promise<{ serviceId: string }> };

/**
 * What one service is saying, as Server-Sent Events.
 *
 * The same shape as the project and backup streams — replay what already
 * happened, then follow — and the first one under `/api/services`. A console
 * session outlives the page that opened it, so a reload that showed an empty
 * pane above a shell that is still running would be a lie about the state of
 * the machine.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { serviceId } = await params;

  const db = await getDb();
  const service = await db
    .selectFrom("services")
    .select(["id", "status"])
    .where("id", "=", serviceId)
    .executeTakeFirst();

  if (!service) return new Response("Servizio non trovato", { status: 404 });

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: ServiceEvent | Record<string, unknown>) => {
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

      const open = consoleState(serviceId);
      send({ type: "ready", serviceId, status: service.status, console: open });

      // Whatever the session has already printed, so a reload or a second tab
      // does not start from a blank pane above a live shell.
      if (open) {
        for (const text of consoleBacklog(serviceId)) {
          send({ type: "console:output", mode: open.mode, text });
        }
      }

      unsubscribe = serviceEvents.subscribe(serviceId, send);

      heartbeat = setInterval(() => {
        if (closed) return;
        // Doubles as the "somebody is still watching" signal — see
        // `touchConsole`. It is what keeps a log follower alive while a viewer
        // is attached, and what lets it be reaped once none is.
        touchConsole(serviceId);
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
