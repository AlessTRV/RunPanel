import { NextRequest } from "next/server";
import { isDenied, requireService } from "@/lib/auth-guard";
import { serviceAllows, watchAccess } from "@/lib/stream-guard";
import { getDb } from "@/lib/db";
import { serviceEvents, type ServiceEvent } from "@/services/events";
import { consoleBacklog, consoleState, touchConsole } from "@/services/service-console";
import { applyLog, isApplyInFlight, parseApplyJournal } from "@/services/service-mounts";

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
  const { serviceId } = await params;
  const denied = await requireService(serviceId, "view");
  if (isDenied(denied)) return denied;

  const db = await getDb();
  const service = await db
    .selectFrom("services")
    .select(["id", "status", "mount_apply"])
    .where("id", "=", serviceId)
    .executeTakeFirst();

  if (!service) return new Response("Servizio non trovato", { status: 404 });

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let stopWatching: (() => void) | null = null;
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
        stopWatching?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed by the client going away */
        }
      };

      const me = denied.session.user.id;
      const open = consoleState(serviceId, me);
      const apply = parseApplyJournal(service.mount_apply);
      send({ type: "ready", serviceId, status: service.status, console: open, apply });

      // Whatever the session has already printed, so a reload or a second tab
      // does not start from a blank pane above a live shell.
      if (open) {
        for (const text of consoleBacklog(serviceId, me)) {
          send({ type: "console:output", userId: me, mode: open.mode, text });
        }
      }

      // The same for an apply: seeding a large folder runs for minutes, and a
      // page opened halfway through that showed nothing until the next line
      // would look stuck.
      if (isApplyInFlight(apply)) {
        for (const line of applyLog(serviceId).split("\n")) {
          if (line) send({ type: "mount:log", line });
        }
      }

      // A console session belongs to the person who opened it.
      unsubscribe = serviceEvents.subscribe(serviceId, (event) => {
        if ((event.type === "console:output" || event.type === "console:closed") && event.userId !== me) return;
        send(event);
      });

      heartbeat = setInterval(() => {
        if (closed) return;
        // Doubles as the "somebody is still watching" signal — see
        // `touchConsole`. It is what keeps a log follower alive while a viewer
        // is attached, and what lets it be reaped once none is.
        touchConsole(serviceId, me);
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, 25_000);

      // Ends the stream once this session or its access to what it shows is gone.

      stopWatching = watchAccess(

        { userId: denied.session.user.id, sessionId: denied.session.sessionId },

        serviceAllows(serviceId, "view"),

        cleanup

      );

      request.signal.addEventListener("abort", cleanup);
    },

    cancel() {
      unsubscribe?.();
      stopWatching?.();
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
