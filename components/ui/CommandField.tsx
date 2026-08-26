"use client";

/**
 * A labelled multi-line command box.
 *
 * Six of these were inline copies before, all in the project settings tab. It
 * lives out here rather than in that file because the one-time commands editor
 * is the third consumer, and a third copy of a textarea nobody can restyle in
 * one place is how the first six happened.
 *
 * A plain `textarea` and not HeroUI's `TextField`: every use is a shell script
 * where a newline is meaningful, and the monospace + resize-y pair is the whole
 * point of the control.
 */
export function CommandField({
  label,
  hint,
  value,
  placeholder,
  rows = 2,
  isDisabled = false,
  onChange,
}: {
  label?: string;
  hint?: React.ReactNode;
  value: string;
  placeholder?: string;
  rows?: number;
  isDisabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      {label && <label className="text-muted mb-1 block text-sm font-medium">{label}</label>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        disabled={isDisabled}
        aria-label={label}
        className="border-border bg-background text-foreground focus:border-accent/60 w-full resize-y rounded-[var(--radius)] border px-3 py-2 font-mono text-sm outline-none disabled:opacity-60"
      />
      {hint && <p className="text-muted mt-1 text-meta">{hint}</p>}
    </div>
  );
}
