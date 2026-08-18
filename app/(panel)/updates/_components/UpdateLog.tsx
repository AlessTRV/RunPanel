"use client";

import { useEffect, useRef } from "react";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";
import { useEventStream } from "@/lib/hooks/useEventStream";
import { useLineBuffer } from "@/lib/hooks/useLineBuffer";
import type { UpdateRun } from "@/lib/panel-update";

/**
 * The output of the update, live while it runs and as a document once it is
 * over.
 *
 * Two sources, and the split is forced rather than chosen. `EventSource`
 * reconnects by itself, so a stream that replayed a finished log and closed
 * would be reopened and replayed forever; the live run gets the stream, and a
 * finished one is fetched once from `/api/updates/log`.
 */

type StreamEvent =
  | { type: "ready"; runId: string | null; phase: string | null }
  | { type: "panel-update:log"; line: string }
  | { type: "panel-update:status"; phase: string; step?: string; error?: string };

export function UpdateLog({ run, live }: { run: UpdateRun | null; live: boolean }) {
  const buffer = useLineBuffer<LogLine>(4000);
  const nextId = useRef(0);
  const { reset, push } = buffer;

  // A new run starts from nothing. Without this the previous run's output stays
  // above the new one and reads as if this one had already got that far.
  useEffect(() => {
    reset();
    nextId.current = 0;
  }, [run?.runId, reset]);

  useEventStream<StreamEvent>(live ? "/api/updates/stream" : null, (event) => {
    if (event.type === "panel-update:log") {
      push({ id: nextId.current++, text: event.line });
    }
  });

  // The finished case: one fetch, no socket.
  useEffect(() => {
    if (live || !run) return;

    const controller = new AbortController();
    fetch("/api/updates/log", { signal: controller.signal })
      .then((res) => res.json())
      .then((body: { runId: string | null; lines: string[] }) => {
        if (body.runId !== run.runId) return;
        reset(body.lines.map((text, index) => ({ id: index, text })));
        nextId.current = body.lines.length;
      })
      .catch(() => {
        /* the panel may simply be restarting; the poll above will say so */
      });

    return () => controller.abort();
  }, [live, run, reset]);

  if (!run) return null;

  return <LogViewer lines={buffer.lines} className="h-80" ariaLabel="Log dell'aggiornamento" />;
}
