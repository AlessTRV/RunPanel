"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";
import { ShellInput } from "@/components/ui/ShellInput";

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

      {/* The shared viewer, inline: the shell streams chunks, not lines. It
          also brings "Segui output", which this tab's own copy never had —
          scrolling up to read stopped working the moment a new chunk arrived. */}
      <LogViewer
        lines={lines}
        inline
        ariaLabel="Output del terminale"
        emptyMessage="Avvia la shell per aprire un terminale dentro il container."
        className="h-[320px] sm:h-[440px]"
      />

      {active && <ShellInput value={input} onChange={setInput} onSubmit={send} />}
    </div>
  );
}
