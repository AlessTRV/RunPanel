import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { HOST_CHANNEL, opsEvents, type OpsEvent } from "@/services/events";
import { logPathFor, readLogFile } from "@/services/log-file";
import { currentRun, updateLogDir } from "@/services/panel-update/run";
import { isTerminal } from "@/services/panel-update/state";

/**
 * The live log of the update, as Server-Sent Events.
 *
 * Same shape as the backup stream: replay what already happened, then follow.
 * The replay matters more here than anywhere else in the panel, because this is
 * the one stream whose server deliberately goes away — the page reconnects
 * after the restart and has to be able to read what happened while it was gone.
 *
 * Not keyed by run id, unlike the backup one. There is only ever one update in
 * flight, and the page has to be able to attach before it knows the id.
 */
export async function GET(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const run = currentRun();
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

      send({ type: "ready", runId: run?.runId ?? null, phase: run?.phase ?? null });

      if (run) {
        for (const line of readLogFile(logPathFor(updateLogDir(), run.runId)).split("\n")) {
          if (line) send({ type: "panel-update:log", line });
        }
      }

      // A finished run has nothing more to say. Closing rather than holding the
      // connection open also matters after a restart: the page reconnects the
      // moment the panel answers, and a stream left open on a done run would
      // keep it waiting for an event that will never come.
      if (!run || isTerminal(run.phase) || run.phase === "awaiting-manual") {
        send({
          type: "panel-update:status",
          phase: run?.phase ?? "idle",
          step: run?.step ?? undefined,
          error: run?.error ?? undefined,
        });
        cleanup();
        return;
      }

      unsubscribe = opsEvents.subscribe(HOST_CHANNEL, (event) => {
        // The channel carries backups and the boot reconciler too.
        if (!event.type.startsWith("panel-update:")) return;
        send(event);
      });

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
