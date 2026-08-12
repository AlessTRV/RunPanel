"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Subscribe to a Server-Sent Events endpoint.
 *
 * The mechanics that were in `useProjectStream`, with the project taken out of
 * them: backups and restores need exactly the same behaviour on a different
 * URL, and a second copy would be a second place for the handler-ref subtlety
 * below to be got wrong.
 *
 * `EventSource` reconnects by itself, which is most of why any of this is SSE
 * rather than a WebSocket.
 */
export function useEventStream<TEvent>(
  url: string | null,
  onEvent: (event: TEvent) => void
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
    if (!url) return;

    const source = new EventSource(url);

    const handleOpen = () => setConnected(true);
    const handleError = () => setConnected(false);
    const handleMessage = (event: MessageEvent<string>) => {
      try {
        handlerRef.current(JSON.parse(event.data) as TEvent);
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
  }, [url]);

  return { connected };
}
