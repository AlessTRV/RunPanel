"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import type { LogLine } from "@/components/ui/LogViewer";

/**
 * A shell inside the project's container.
 *
 * Output arrives on the project's event stream — the parent owns the
 * subscription and passes the lines down — so nothing here polls. It used to
 * fetch every second, which made typing feel laggy and kept a request
 * permanently in flight for as long as the tab was open.
 */
export function TerminalTab({
  projectId,
  lines,
  active,
  onActiveChange,
  onLocalEcho,
}: {
  projectId: string;
  lines: LogLine[];
  active: boolean;
  onActiveChange: (active: boolean) => void;
  onLocalEcho: (text: string) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  async function start() {
    setStarting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/terminal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      if (res.ok) onActiveChange(true);
      else onLocalEcho("Impossibile avviare la shell\n");
    } catch {
      onLocalEcho("Impossibile avviare la shell\n");
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    try {
      await fetch(`/api/projects/${projectId}/terminal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
    } catch {
      /* the session may already be gone */
    }
    onActiveChange(false);
  }

  function send() {
    const command = input;
    setInput("");
    // Echo locally so the prompt feels immediate; the container's own output
    // follows on the stream.
    onLocalEcho(`$ ${command}\n`);
    void fetch(`/api/projects/${projectId}/terminal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: `${command}\n` }),
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {active ? (
          <Button variant="danger" size="sm" onPress={stop}>
            <Icon icon="solar:stop-linear" width={16} aria-hidden />
            Termina shell
          </Button>
        ) : (
          <Button variant="primary" size="sm" isPending={starting} onPress={start}>
            <Icon icon="solar:play-linear" width={16} aria-hidden />
            Avvia shell
          </Button>
        )}
      </div>

      <div
        ref={scrollRef}
        role="log"
        aria-label="Output del terminale"
        className="border-border bg-background h-[320px] overflow-auto rounded-[var(--radius)] border p-3 font-mono text-xs leading-relaxed sm:h-[440px]"
      >
        {lines.length === 0 ? (
          <p className="text-muted">Avvia la shell per aprire un terminale dentro il container.</p>
        ) : (
          // Keyed by id, not index: this buffer is trimmed from the FRONT, so
          // an index key shifts under every row and React rewrites the whole
          // list. Same mistake LogViewer documents having fixed.
          lines.map((line) => (
            <span key={line.id} className="text-foreground/85 break-all whitespace-pre-wrap">
              {line.text}
            </span>
          ))
        )}
      </div>

      {active && (
        <div className="flex items-center gap-2">
          <span className="text-muted font-mono text-sm" aria-hidden>
            $
          </span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
            placeholder="Scrivi un comando…"
            aria-label="Comando da eseguire"
            className="border-border bg-surface text-foreground focus:border-accent/60 flex-1 rounded-[var(--radius)] border px-3 py-2 font-mono text-sm outline-none"
          />
        </div>
      )}
    </div>
  );
}
