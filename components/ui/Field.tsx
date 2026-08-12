"use client";

import { cn } from "@/lib/utils";
import { FieldHint } from "./Hint";
import { InfoTip } from "./Tooltip";

/**
 * Label, control, and the two things that can sit under it.
 *
 * Two problems this closes. Validation errors were being announced by toast —
 * "Deve iniziare con una lettera minuscola; solo minuscole, numeri e
 * underscore" fired as a notification while the offending field sat untouched a
 * few pixels away, and the toast was gone before the correction was typed. And
 * every screen laid out its own label/hint stack, so the gap under a label was
 * a different number in a different file.
 *
 * `hint` and `error` share one slot on purpose: while something is wrong, the
 * correction is the only thing worth the space. `explain` is the escape valve
 * that lets the hint stay short — the sentence that used to justify a whole
 * Hint block goes there and is read on request.
 */
export function Field({
  label,
  htmlFor,
  explain,
  hint,
  error,
  children,
  className,
}: {
  label: React.ReactNode;
  /** Set it whenever the control is a plain input rather than a HeroUI TextField. */
  htmlFor?: string;
  /** The long "why", behind an ⓘ. */
  explain?: React.ReactNode;
  /** The short "what to type". Replaced by `error` while one is present. */
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center gap-1">
        <label htmlFor={htmlFor} className="text-foreground text-sm">
          {label}
        </label>
        {explain && <InfoTip title={typeof label === "string" ? label : undefined}>{explain}</InfoTip>}
      </div>

      {children}

      {error ? (
        <p role="alert" className="text-danger text-meta leading-relaxed">
          {error}
        </p>
      ) : (
        hint && <FieldHint className="mt-0">{hint}</FieldHint>
      )}
    </div>
  );
}
