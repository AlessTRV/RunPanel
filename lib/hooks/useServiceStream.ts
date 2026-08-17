"use client";

import { useEventStream } from "./useEventStream";

export type ConsoleMode = "engine" | "shell" | "logs";

/**
 * Declared here rather than imported from `services/events.ts`, the same way
 * `useProjectStream` re-declares `ProjectEvent`: that module reaches the
 * database and the drivers, and this one is bundled for the browser. The price
 * is that a new event has to be added in both places.
 */
export type ServiceStreamEvent =
  | { type: "ready"; serviceId: string; status: string; console: { active: boolean; mode: ConsoleMode } | null }
  | { type: "console:output"; mode: ConsoleMode; text: string }
  | { type: "console:closed"; mode: ConsoleMode; code: number | null };

/**
 * Subscribes to one service's event stream.
 *
 * One connection per page, opened by the page and fanned out to whoever needs
 * it — the transport lives in `useEventStream`, and what remains here is the
 * URL and the event union, which is all a caller should have to know.
 */
export function useServiceStream(
  serviceId: string | null,
  onEvent: (event: ServiceStreamEvent) => void
): { connected: boolean } {
  return useEventStream<ServiceStreamEvent>(
    serviceId ? `/api/services/${serviceId}/stream` : null,
    onEvent
  );
}
