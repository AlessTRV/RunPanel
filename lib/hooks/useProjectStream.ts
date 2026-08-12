"use client";

import { useEventStream } from "./useEventStream";

export type StreamEvent =
  | { type: "ready"; projectId: string; status: string }
  | { type: "deploy:status"; deploymentId: string; status: string; message?: string }
  | { type: "deploy:log"; deploymentId: string; line: string }
  | { type: "process:log"; line: string; stream: "stdout" | "stderr" }
  /** A new run is starting: the output shown so far belongs to the old one. */
  | { type: "process:reset" }
  | { type: "process:status"; status: string; running: boolean; pid?: number; uptime?: number }
  | { type: "terminal:output"; text: string }
  | { type: "terminal:closed"; code: number | null };

/**
 * Subscribes to a project's event stream.
 *
 * One connection carries deploy status, build output and process output, so a
 * page does not need a poller per widget. The transport lives in
 * `useEventStream`; what remains here is the URL and the event union, which is
 * all a caller should have to know.
 */
export function useProjectStream(
  projectId: string | null,
  onEvent: (event: StreamEvent) => void
): { connected: boolean } {
  return useEventStream<StreamEvent>(
    projectId ? `/api/projects/${projectId}/stream` : null,
    onEvent
  );
}
