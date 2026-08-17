"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";
import { Hint } from "@/components/ui/Hint";
import { Segmented } from "@/components/ui/Segmented";
import type { ConsoleMode } from "@/lib/hooks/useServiceStream";

/**
 * Talking to the service, from the page that knows its credentials.
 *
 * Three modes behind one pane, because they answer three versions of the same
 * question and only one of them can be open at a time anyway: the engine's own
 * client for "what is in there", a shell for "what is on its disk", and the
 * container's log for "why is it unhappy".
 *
 * Line-oriented on purpose rather than by omission. `docker exec` with piped
 * stdio cannot allocate a TTY, so no client prints a prompt and none of them
 * would read a keystroke stream anyway — the prompt below is drawn here, and
 * what crosses the wire is a whole line at a time.
 */

const MODES = [
  { value: "engine" as const, label: "Motore", icon: "solar:database-linear" },
  { value: "shell" as const, label: "Shell", icon: "solar:command-linear" },
  { value: "logs" as const, label: "Log", icon: "solar:document-text-linear" },
];

const MODE_NOTE: Record<ConsoleMode, string> = {
  engine: "Il client del motore, già autenticato con le credenziali del servizio.",
  shell: "Una shell dentro il container.",
  logs: "Quello che il container scrive, in diretta. Sola lettura, e non viene salvato.",
};

/** What the panel draws in place of the prompt no client can print without a TTY. */
const PROMPT: Record<ConsoleMode, string> = { engine: "›", shell: "#", logs: "" };

export function ConsolePanel({
  serviceId,
  running,
  mode,
  onModeChange,
  active,
  onActiveChange,
  lines,
  onLocalEcho,
}: {
  serviceId: string;
  running: boolean;
  mode: ConsoleMode;
  onModeChange: (next: ConsoleMode) => void;
  active: boolean;
  onActiveChange: (active: boolean) => void;
  lines: LogLine[];
  onLocalEcho: (text: string) => void;
}) {
  // Per mount, and only for the two modes that can change something. Asking
  // again on every mode switch would turn an acknowledgement into a click.
  const [acknowledged, setAcknowledged] = useState(false);
  const [starting, setStarting] = useState(false);
  const [input, setInput] = useState("");

  const readOnly = mode === "logs";
  const needsAck = !readOnly && !acknowledged;

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/services/${serviceId}/console`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, body: await res.json().catch(() => ({})) };
  }

  async function start(next: ConsoleMode) {
    setStarting(true);
    try {
      const { ok, body } = await post({
        action: "start",
        mode: next,
        // The server checks this too — a confirmation that can be skipped by
        // posting straight at the endpoint is not a confirmation.
        ...(next === "logs" ? {} : { confirmed: true }),
      });
      if (!ok) {
        onLocalEcho(`${body.error ?? "Apertura non riuscita"}\n`);
        return;
      }
      onActiveChange(true);
    } catch {
      onLocalEcho("Apertura non riuscita\n");
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    try {
      await post({ action: "stop" });
    } catch {
      /* best effort: the reaper gets it either way */
    }
    onActiveChange(false);
  }

  function send() {
    const command = input.trim();
    if (!command) return;
    setInput("");
    // Echoed here so the line appears the instant it is sent: without a TTY
    // nothing on the other side is going to echo it back.
    onLocalEcho(`${PROMPT[mode]} ${command}\n`);
    void post({ action: "input", input: `${command}\n` });
  }

  return (
    <Panel className="space-y-3">
      <PanelHeader
        title="Console"
        description={MODE_NOTE[mode]}
        actions={
          active ? (
            <Button variant="danger" size="sm" onPress={stop}>
              <Icon icon="solar:stop-linear" width={16} aria-hidden />
              Chiudi
            </Button>
          ) : undefined
        }
      />

      <Segmented
        label="Modalità della console"
        value={mode}
        onChange={(next) => onModeChange(next as ConsoleMode)}
        options={MODES}
      />

      {needsAck ? (
        <Hint tone="warn" title="Quello che scrivi qui succede davvero">
          Questa è una sessione diretta sul database: un <code>DROP</code> o un{" "}
          <code>rm</code> qui non passano da nessuna conferma e non si annullano. Il pannello non
          tiene una copia — se non c&apos;è un backup, non c&apos;è modo di tornare indietro.
        </Hint>
      ) : null}

      <LogViewer
        lines={lines}
        ariaLabel="Output della console"
        emptyMessage={
          active
            ? "Sessione aperta. Scrivi un comando qui sotto."
            : "Apri una sessione per vedere l'output."
        }
        className="h-[320px] sm:h-[440px]"
      />

      {active ? (
        !readOnly && (
          <div className="flex items-center gap-2">
            <span className="text-muted shrink-0 font-mono text-xs" aria-hidden>
              {PROMPT[mode]}
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
              className="border-border bg-background text-foreground focus:border-accent min-w-0 flex-1 rounded-[var(--radius)] border px-3 py-2 font-mono text-xs outline-none"
            />
          </div>
        )
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            isPending={starting}
            isDisabled={!running && !readOnly}
            onPress={() => {
              if (needsAck) setAcknowledged(true);
              void start(mode);
            }}
          >
            <Icon icon="solar:play-linear" width={16} aria-hidden />
            {needsAck ? "Ho capito, apri la console" : "Apri la console"}
          </Button>
          {!running && !readOnly && (
            <span className="text-muted text-xs">
              Il servizio è fermo: avvialo per aprire una sessione.
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}
