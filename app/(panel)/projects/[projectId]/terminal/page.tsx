"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";

type Mode = "logs" | "shell";

export default function TerminalPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  const [mode, setMode] = useState<Mode>("logs");
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState("");
  const termRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seenLogsRef = useRef(new Set<string>());

  // === LOGS MODE ===
  const pollLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/logs?source=process`);
      if (!res.ok) return;
      const data = await res.json();
      const logLines = data.logs as string[] || [];
      const newLines: string[] = [];
      for (const l of logLines) {
        if (!seenLogsRef.current.has(l)) {
          seenLogsRef.current.add(l);
          newLines.push(l);
        }
      }
      if (newLines.length > 0) {
        setLines((prev) => [...prev, ...newLines.map((l) => l + "\n")]);
      }
    } catch { /* ignore */ }
  }, [projectId]);

  // === SHELL MODE ===
  const startShell = useCallback(async () => {
    setStarting(true);
    setLines([]);
    try {
      const res = await fetch(`/api/projects/${projectId}/terminal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const data = await res.json();
      if (res.ok) {
        setActive(true);
        setLines([`Shell started in ${data.cwd}\n\n`]);
      }
    } catch {
      setLines(["Failed to start terminal session\n"]);
    } finally {
      setStarting(false);
    }
  }, [projectId]);

  const stopShell = useCallback(async () => {
    try {
      await fetch(`/api/projects/${projectId}/terminal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
    } catch { /* ignore */ }
    setActive(false);
    setLines((prev) => [...prev, "\n[Session ended]\n"]);
  }, [projectId]);

  const sendInput = useCallback(async (input: string) => {
    await fetch(`/api/projects/${projectId}/terminal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: input + "\n" }),
    });
  }, [projectId]);

  const pollShellOutput = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/terminal`);
      const data = await res.json();
      if (data.output) {
        setLines((prev) => [...prev, data.output]);
      }
      if (!data.active) setActive(false);
    } catch { /* ignore */ }
  }, [projectId]);

  // Polling effect
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);

    if (mode === "logs") {
      seenLogsRef.current.clear();
      setLines([]);
      pollLogs();
      pollRef.current = setInterval(pollLogs, 2000);
    } else if (mode === "shell" && active) {
      pollRef.current = setInterval(pollShellOutput, 300);
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [mode, active, pollLogs, pollShellOutput]);

  // Auto-scroll
  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [lines]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (active) {
        fetch(`/api/projects/${projectId}/terminal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        }).catch(() => {});
      }
    };
  }, [active, projectId]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      const cmd = inputValue;
      setInputValue("");
      setLines((prev) => [...prev, `$ ${cmd}\n`]);
      sendInput(cmd);
    }
  }

  function switchMode(newMode: Mode) {
    if (active && mode === "shell") {
      stopShell();
    }
    seenLogsRef.current.clear();
    setLines([]);
    setMode(newMode);
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Terminal</h1>
          <p className="text-sm text-foreground-400">
            {mode === "logs" ? "Live process output from PM2" : "Interactive shell in the project directory"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={mode === "logs" ? "primary" : "outline"}
            size="sm"
            onPress={() => switchMode("logs")}
          >
            <Icon icon="solar:document-text-bold-duotone" width={16} />
            Process Logs
          </Button>
          <Button
            variant={mode === "shell" ? "primary" : "outline"}
            size="sm"
            onPress={() => switchMode("shell")}
          >
            <Icon icon="solar:monitor-bold-duotone" width={16} />
            Shell
          </Button>
        </div>
      </div>

      {mode === "shell" && !active && (
        <div className="mb-2">
          <Button variant="primary" size="sm" isDisabled={starting} onPress={startShell}>
            {starting ? <Spinner /> : <Icon icon="solar:play-bold" width={16} />}
            Start Shell
          </Button>
        </div>
      )}
      {mode === "shell" && active && (
        <div className="mb-2">
          <Button variant="danger" size="sm" onPress={stopShell}>
            <Icon icon="solar:stop-bold" width={16} />
            Stop Shell
          </Button>
        </div>
      )}

      <div
        ref={termRef}
        className="h-[500px] overflow-auto rounded-xl bg-black p-4 font-mono text-sm text-green-400"
      >
        {lines.length === 0 && (
          <p className="text-foreground-500">
            {mode === "logs"
              ? "Waiting for process logs..."
              : 'Click "Start Shell" to open an interactive terminal in the project directory.'}
          </p>
        )}
        {lines.map((line, i) => (
          <span key={i} className="whitespace-pre-wrap break-all">
            {line}
          </span>
        ))}
      </div>

      {mode === "shell" && active && (
        <div className="mt-2 flex gap-2">
          <span className="flex items-center font-mono text-sm text-green-400">$</span>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            autoFocus
            className="flex-1 rounded-lg border border-divider bg-black px-3 py-2 font-mono text-sm text-green-400 outline-none focus:border-primary"
          />
        </div>
      )}
    </div>
  );
}
