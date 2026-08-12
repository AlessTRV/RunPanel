"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface LineBuffer<T> {
  lines: T[];
  /** Queue a line. It becomes visible on the next flush, not immediately. */
  push(item: T): void;
  /** Replace the contents now, dropping anything still queued. */
  reset(next?: T[]): void;
}

/**
 * A capped, batched append-only buffer for streamed output.
 *
 * Each incoming line used to be its own state update, and each state update
 * copied the whole array and re-rendered the viewer. A `docker build` emits
 * hundreds of lines a second, and the buffer holds up to two thousand: that is
 * hundreds of 2000-element copies and hundreds of full re-renders per second,
 * which is what made the tab unusable during exactly the moment it matters.
 *
 * Lines are collected in a ref and published on a timer, so a burst costs one
 * render regardless of how many lines it carried. 100ms is below the point
 * where output stops looking live.
 *
 * The same trick the server already uses to avoid one write syscall per line —
 * see `services/log-file.ts`.
 */
export function useLineBuffer<T>(max: number, flushMs = 100): LineBuffer<T> {
  const [lines, setLines] = useState<T[]>([]);
  const pending = useRef<T[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    if (pending.current.length === 0) return;

    const batch = pending.current;
    pending.current = [];

    setLines((prev) => {
      const out = prev.concat(batch);
      return out.length > max ? out.slice(out.length - max) : out;
    });
  }, [max]);

  const push = useCallback(
    (item: T) => {
      pending.current.push(item);
      if (timer.current === null) timer.current = setTimeout(flush, flushMs);
    },
    [flush, flushMs]
  );

  const reset = useCallback((next: T[] = []) => {
    pending.current = [];
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setLines(next);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  return { lines, push, reset };
}
