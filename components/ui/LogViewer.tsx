"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface LogLine {
  /** Monotonic and stable — never the array index, or React reuses rows on prepend. */
  id: number;
  text: string;
  stream?: "stdout" | "stderr";
}

/**
 * Scrolling log output.
 *
 * Two behaviours the old inline version got wrong:
 *  - it followed the tail unconditionally, so scrolling back to read something
 *    yanked you to the bottom on the next line;
 *  - it keyed rows by array index, which makes React rewrite every row whenever
 *    the buffer is trimmed.
 */
export function LogViewer({
  lines,
  emptyMessage = "Nessun output.",
  className,
  ariaLabel = "Log",
  inline = false,
}: {
  lines: LogLine[];
  emptyMessage?: string;
  className?: string;
  ariaLabel?: string;
  /**
   * For a raw terminal stream, whose chunks are not lines: a prompt, half a
   * line, then the rest. As blocks each chunk would start a new row and split
   * the output where the bytes happened to arrive; inline, the newlines in the
   * text decide.
   */
  inline?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !following) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, following]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    // A small slack so the tail still counts as "at the bottom" mid-animation.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollowing(atBottom);
  }

  return (
    <div className={cn("relative", className)}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        role="log"
        aria-label={ariaLabel}
        aria-live="polite"
        className="border-border bg-background h-full overflow-auto rounded-[var(--radius)] border p-3 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="text-muted">{emptyMessage}</p>
        ) : (
          lines.map((line) => {
            const tone = line.stream === "stderr" ? "text-danger" : "text-foreground/80";
            return inline ? (
              <span key={line.id} className={cn("break-all whitespace-pre-wrap", tone)}>
                {line.text}
              </span>
            ) : (
              <div key={line.id} className={cn("break-words whitespace-pre-wrap", tone)}>
                {line.text}
              </div>
            );
          })
        )}
      </div>

      {!following && (
        <button
          type="button"
          onClick={() => {
            setFollowing(true);
            const el = containerRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="border-border bg-surface text-foreground hover:bg-surface-hover absolute right-3 bottom-3 rounded-full border px-3 py-1 text-xs shadow-lg transition-colors"
        >
          Segui output
        </button>
      )}
    </div>
  );
}
