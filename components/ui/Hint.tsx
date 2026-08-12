import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

/**
 * The inline explanation that sits next to a form or a field.
 *
 * Every screen had grown its own shape for this: a `<p className="text-muted
 * text-xs">` here, a Panel with an icon copied out of the env tab there, a
 * `[11px]` note under a textarea somewhere else. Three recipes for one job, so a
 * hint read as an accident rather than as part of the page — and nobody added
 * one because it meant inventing the styling again.
 *
 * With a single component a screen can afford to explain itself: what a port
 * actually does under this runtime, where a path is resolved from, which
 * variable a provisioned database arrives as.
 */

type Tone = "info" | "tip" | "warn";

const TONES: Record<Tone, { icon: string; iconClass: string; border: string }> = {
  /** Neutral context: how something works. */
  info: { icon: "solar:info-circle-linear", iconClass: "text-muted", border: "border-border" },
  /** Something the reader can do that saves them work. */
  tip: { icon: "solar:lightbulb-linear", iconClass: "text-accent", border: "border-accent/30" },
  /** A trap: correct-looking input that behaves differently than expected. */
  warn: { icon: "solar:danger-triangle-linear", iconClass: "text-warning", border: "border-warning/35" },
};

export function Hint({
  tone = "info",
  icon,
  title,
  children,
  className,
}: {
  tone?: Tone;
  /** Overrides the tone's icon where a more specific one says more. */
  icon?: string;
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const preset = TONES[tone];

  return (
    <div
      className={cn(
        "bg-surface-secondary/60 flex items-start gap-2.5 rounded-[var(--radius)] border px-3 py-2.5",
        preset.border,
        className
      )}
    >
      <Icon
        icon={icon ?? preset.icon}
        width={16}
        className={cn("mt-px shrink-0", preset.iconClass)}
        aria-hidden
      />
      <div className="text-muted min-w-0 flex-1 text-xs leading-relaxed">
        {title && <p className="text-foreground mb-0.5 font-medium">{title}</p>}
        {children}
      </div>
    </div>
  );
}

/** The one-line note under a single field. Smaller, no box, no icon. */
export function FieldHint({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("text-muted mt-1.5 text-[11px] leading-relaxed", className)}>{children}</p>
  );
}

/** An inline literal — a variable name, a path, a command. */
export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        "bg-surface-tertiary text-foreground rounded px-1 py-0.5 font-mono text-[0.95em]",
        className
      )}
    >
      {children}
    </code>
  );
}
