"use client";

import { useEffect, useRef, useState } from "react";

export type StreamEvent =
  | { type: "ready"; projectId: string; status: string }
  | { type: "deploy:status"; deploymentId: string; status: string; message?: string }
  | { type: "deploy:log"; deploymentId: string; line: string }
  | { type: "process:log"; line: string; stream: "stdout" | "stderr" }
  | { type: "process:status"; status: string; running: boolean; pid?: number; uptime?: number }
  | { type: "terminal:output"; text: string }
  | { type: "terminal:closed"; code: number | null };

/**
 * Subscribes to a project's event stream.
 *
 * One connection carries deploy status, build output and process output, so a
 * page does not need a poller per widget. `EventSource` reconnects by itself,
 * which is most of why this is SSE rather than a WebSocket.
 *
 * The handler is kept in a ref so a caller can pass an inline closure without
 * tearing the connection down on every render.
 */
export function useProjectStream(
  projectId: string | null,
  onEvent: (event: StreamEvent) => void
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);

  // Updated in an effect rather than during render: writing a ref while
  // rendering is a side effect, and React is free to render without committing.
  // Declared before the subscription effect, so the handler is always current
  // by the time any event can arrive.
  useEffect(() => {
    handlerRef.current = onEvent;
  });

  useEffect(() => {
    if (!projectId) return;

    const source = new EventSource(`/api/projects/${projectId}/stream`);

    const handleOpen = () => setConnected(true);
    const handleError = () => setConnected(false);
    const handleMessage = (event: MessageEvent<string>) => {
      try {
        handlerRef.current(JSON.parse(event.data) as StreamEvent);
      } catch {
        /* a malformed frame should not kill the subscription */
      }
    };

    source.addEventListener("open", handleOpen);
    source.addEventListener("error", handleError);
    source.addEventListener("message", handleMessage);

    return () => {
      source.removeEventListener("open", handleOpen);
      source.removeEventListener("error", handleError);
      source.removeEventListener("message", handleMessage);
      source.close();
      setConnected(false);
    };
  }, [projectId]);

  return { connected };
}
