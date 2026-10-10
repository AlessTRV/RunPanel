"use client";

/**
 * The command line under a terminal or a console: a prompt and one field.
 *
 * The project terminal and the service console had each written their own,
 * with a different background, text size and focus colour, for the same
 * gesture. Enter sends; the caller decides what sending means.
 */
export function ShellInput({
  value,
  onChange,
  onSubmit,
  prompt = "$",
  placeholder = "Scrivi un comando…",
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  prompt?: string;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted shrink-0 font-mono text-xs" aria-hidden>
        {prompt}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
        placeholder={placeholder}
        aria-label="Comando da eseguire"
        autoComplete="off"
        spellCheck={false}
        className="border-border bg-background text-foreground focus:border-accent min-w-0 flex-1 rounded-[var(--radius)] border px-3 py-2 font-mono text-xs outline-none"
      />
    </div>
  );
}
