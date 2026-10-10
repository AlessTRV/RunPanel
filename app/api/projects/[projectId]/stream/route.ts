import { NextRequest } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { projectAllows, watchAccess } from "@/lib/stream-guard";
import { getDb } from "@/lib/db";
import { projectEvents, type ProjectEvent } from "@/services/events";
import { processLogHub } from "@/services/process-logs";
import { readBuildLog } from "@/services/build-logs";

type Params = { params: Promise<{ projectId: string }> };

/**
 * One Server-Sent Events stream carrying everything that happens to a project:
 * deploy status, build output, and process output.
 *
 * This replaces three independent pollers — status every 5s, process logs every
 * 3s, terminal every 1s — each of which re-fetched a whole buffer and made the
 * client work out what was new. The build log in particular was never visible
 * live at all: it could only be read from a finished deployment.
 *
 * SSE rather than WebSockets: the traffic is one-directional, it survives
 * ordinary reverse proxies, and the browser reconnects on its own.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "view");
  if (isDenied(denied)) return denied;
  const db = await getDb();

  const project = await db
    .selectFrom("projects")
    .select(["id", "slug", "runtime_type", "status"])
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return new Response("Project not found", { status: 404 });
  }

  // Replay the in-flight deployment's log so a browser that connects mid-build
  // sees what already happened instead of starting from the next line.
  const active = await db
    .selectFrom("deployments")
    .select(["id", "status"])
    .where("project_id", "=", projectId)
    .where("status", "in", ["pending", "building"])
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let stopWatching: (() => void) | null = null;
  let detachLogs: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: ProjectEvent | { type: "ready" | "ping" } | Record<string, unknown>) => {
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
        detachLogs?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed by the client going away */
        }
      };

      send({ type: "ready", projectId, status: project.status });

      if (active) {
        const backlog = readBuildLog(active.id, 500);
        for (const line of backlog.split("\n")) {
          if (line) send({ type: "deploy:log", deploymentId: active.id, line });
        }
      }

      // A shell's output belongs to the person who opened it.
      const me = denied.session.user.id;
      unsubscribe = projectEvents.subscribe(projectId, (event) => {
        if ((event.type === "terminal:output" || event.type === "terminal:closed") && event.userId !== me) return;
        send(event);
      });
      detachLogs = processLogHub.attach(projectId, project.slug, project.runtime_type);

      // Proxies and browsers drop a stream that goes quiet. A comment frame is
      // ignored by EventSource but keeps the connection accounted for.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, 25_000);

      // Ends the stream once this session or its access to what it shows is gone.

      stopWatching = watchAccess(

        { userId: denied.session.user.id, sessionId: denied.session.sessionId },

        projectAllows(projectId, "view"),

        cleanup

      );

      request.signal.addEventListener("abort", cleanup);
    },

    cancel() {
      unsubscribe?.();
      stopWatching?.();
      detachLogs?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // nginx buffers proxied responses by default, which would hold every
      // event until the buffer fills — i.e. defeat the whole point.
      "X-Accel-Buffering": "no",
    },
  });
}
