"use client";

import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { useClipboard } from "@/lib/hooks/useClipboard";

/**
 * Shell commands to run somewhere else, with one button to take them.
 *
 * The panel generates these when it cannot act itself — a systemd unit it has
 * no permission to install, a `pm2 save` that has to run as the owning user.
 * They are the one place a wall of monospace is the right answer: the reader is
 * going to paste it verbatim, so paraphrasing would be worse than useless.
 *
 * The copy state comes from the shared hook rather than a bare
 * `navigator.clipboard.writeText()`. The old inline version fired a success
 * toast without waiting for the promise, so a blocked clipboard — an insecure
 * origin, an unfocused document — reported success and left the user pasting
 * nothing.
 */
export function CommandBlock({
  commands,
  label = "Comandi copiati",
  className,
}: {
  commands: string[];
  label?: string;
  className?: string;
}) {
  const { copied, copy } = useClipboard();
  const text = commands.join("\n\n");

  return (
    <div
      className={cn(
        "border-border bg-surface-secondary relative rounded-[var(--radius)] border",
        className
      )}
    >
      <Button
        size="sm"
        variant="ghost"
        className="absolute top-2 right-2"
        onPress={() => void copy(text)}
        aria-label={copied ? "Copiati" : "Copia i comandi"}
      >
        <Icon icon={copied ? "solar:check-read-linear" : "solar:copy-linear"} width={15} aria-hidden />
        {copied ? "Copiati" : "Copia"}
      </Button>
      <pre className="text-muted text-meta overflow-x-auto p-3 pr-24 leading-relaxed whitespace-pre">
        {text}
      </pre>
      <span className="sr-only" role="status">
        {copied ? label : ""}
      </span>
    </div>
  );
}
