"use client";

import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

/**
 * One option of a pick-one set that needs more than a word: a runtime, a
 * database engine, a version.
 *
 * The same card had been rebuilt by hand five times — AppForm, the database and
 * template forms, the service type grid — each with its own padding and its own
 * idea of what "selected" looks like. It now says it with the shared `selected`
 * utility, like every other chosen thing in the panel.
 *
 * The parent carries `role="radiogroup"` and an `aria-label` (`ChoiceGroup`);
 * each card is a radio.
 */
export function ChoiceCard({
  selected,
  onSelect,
  title,
  description,
  icon,
  isDisabled,
  compact = false,
  className,
}: {
  selected: boolean;
  onSelect: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: string;
  isDisabled?: boolean;
  /** A pill-sized option, for short values such as a version number. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={isDisabled}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-[var(--radius)] border text-left transition-colors",
        compact ? "px-3 py-1.5 text-sm" : "p-3",
        // Pills sit side by side in rows of up to eight; the full halo of
        // `selected` bleeds into the neighbours there, so they get the hairline.
        selected
          ? cn(compact ? "selected-quiet" : "selected", "border-transparent")
          : "border-border hover:bg-surface-hover",
        isDisabled && "cursor-not-allowed opacity-50",
        className
      )}
    >
      {icon && (
        <Icon
          icon={icon}
          width={20}
          aria-hidden
          className={cn("mt-0.5 shrink-0", selected ? "text-accent" : "text-muted")}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn("text-foreground block truncate", compact ? "" : "text-sm font-medium")}>
          {title}
        </span>
        {description && !compact && (
          <span className="text-muted mt-0.5 block text-xs">{description}</span>
        )}
      </span>
    </button>
  );
}

/** The radiogroup around a set of `ChoiceCard`s. */
export function ChoiceGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("grid gap-2", className)}>
      {children}
    </div>
  );
}
