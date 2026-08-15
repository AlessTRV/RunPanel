"use client";

import { Disclosure } from "@heroui/react";
import { cn } from "@/lib/utils";
import { Panel } from "./Panel";

/**
 * A part of a screen that is closed until it is wanted.
 *
 * This is the mechanism the whole redesign rests on. The panel's density
 * problem was never the number of facts — it was that every screen presented
 * all of them at the same weight, so a page covering six concerns was six
 * identical boxes and the reader had no way to tell what they came for from
 * reference material read once, months ago.
 *
 * A `Section` states what it holds and what it is currently set to, and opens
 * only if that is not enough. The project settings tab goes from thirty visible
 * controls to four this way, without a single fact being deleted.
 *
 * `summary` is what makes it work: a closed section must answer the question it
 * covers, or closing it just hides information. "7 archivi, nessun limite di
 * tempo" is a section that can stay shut; "Retention" is not.
 *
 * `actions` renders in the header, outside the trigger button — for the toggle
 * that turns a whole section's feature on and off without expanding it. Nesting
 * a switch inside the trigger would make one press mean two things.
 */
export function Section({
  title,
  summary,
  actions,
  defaultExpanded = false,
  onExpandedChange,
  children,
  className,
}: {
  title: React.ReactNode;
  /** What this section is currently set to, read without opening it. */
  summary?: React.ReactNode;
  actions?: React.ReactNode;
  defaultExpanded?: boolean;
  /**
   * Told when the section opens, for content that costs something to produce.
   * A section whose body queries a third-party API should not pay for it on
   * every visit to a tab it is closed on.
   */
  onExpandedChange?: (expanded: boolean) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Panel padding="flush" className={cn("overflow-hidden", className)}>
      <Disclosure defaultExpanded={defaultExpanded} onExpandedChange={onExpandedChange}>
        <div className="flex items-center gap-2 pr-4">
          <Disclosure.Heading className="min-w-0 flex-1">
            <Disclosure.Trigger className="hover:bg-surface-hover flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors">
              {/*
                The library's own indicator, not a hand-placed icon: it reads the
                expanded state from context and carries the rotation in its slot
                styling. A chevron driven from here would need a variant that
                does not exist, and an unknown Tailwind variant compiles to
                nothing at all — the arrow would simply never turn.
              */}
              <Disclosure.Indicator className="text-muted shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="text-foreground block truncate text-sm font-medium">{title}</span>
                {summary && (
                  <span className="text-muted block truncate text-meta">{summary}</span>
                )}
              </span>
            </Disclosure.Trigger>
          </Disclosure.Heading>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>

        <Disclosure.Content>
          <div className="border-separator space-y-4 border-t px-4 py-4">{children}</div>
        </Disclosure.Content>
      </Disclosure>
    </Panel>
  );
}
