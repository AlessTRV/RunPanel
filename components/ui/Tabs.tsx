"use client";

import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

/**
 * The row of section tabs.
 *
 * Lifted out of the project page — where it was written inline — at the moment
 * the service page needed the same row. A second copy of a selected state is
 * exactly how the panel ended up with four disagreeing ones before `Segmented`
 * was written, and this one carries a judgement worth keeping in a single
 * place: a tab's grammar is the underline, so it deliberately does **not** take
 * the accent wash every other selected surface here takes.
 *
 * `Segmented` is the sibling for "pick one of a few values". This is for "which
 * part of this page am I looking at" — a different question, and the underline
 * is what says so.
 */

export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** Iconify name. Keep it a literal at the call site — the icon bundler greps for these. */
  icon: string;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Accessible name for the row. */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("border-border mb-5 flex gap-1 overflow-x-auto border-b", className)}
    >
      {tabs.map((tab) => {
        const active = value === tab.id;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors",
              active
                ? "border-accent text-foreground font-medium"
                : "text-muted hover:text-foreground border-transparent"
            )}
          >
            {/* No wash here: a tab's grammar is the underline, and a filled
                pill fighting a bottom border reads as neither. The accent
                icon is what ties it to the rest of the language. */}
            <Icon icon={tab.icon} width={15} aria-hidden className={cn(active && "text-accent")} />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
