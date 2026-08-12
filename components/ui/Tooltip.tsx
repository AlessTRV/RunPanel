"use client";

import { Button, Popover } from "@heroui/react";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

/**
 * How the panel explains something without it being on screen at all times.
 *
 * The panel had 64 always-visible `Hint` blocks. Not because any one of them was
 * wrong — most say something true and useful — but because a static box was the
 * only tool available, so every explanation had to be either permanently present
 * or absent. Screens ended up reading as documentation with form fields wedged
 * between the paragraphs.
 *
 * `InfoTip` covers the case that box was doing badly:
 *
 *   it        carries a real explanation — why something behaves the way it
 *              does, what a field actually changes. Built on Popover rather than
 *              Tooltip precisely because it IS load-bearing: press-triggered, so
 *              it works on touch, is reachable by keyboard, and stays open while
 *              it is read.
 *
 * What stays a `Hint` block: a trap. Input that looks right and behaves
 * differently. That one has to be seen without being asked for.
 */

/**
 * An explanation the reader asks for, next to the label it explains.
 *
 * `title` is optional and worth setting when the popover holds more than one
 * sentence — it gives the dialog an accessible name beyond "Spiegazione".
 */
export function InfoTip({
  title,
  children,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Popover>
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label={title ? `Spiegazione: ${title}` : "Spiegazione"}
        className={cn("text-muted hover:text-foreground -my-1 h-6 w-6 min-w-0", className)}
      >
        <Icon icon="solar:info-circle-linear" width={14} aria-hidden />
      </Button>
      <Popover.Content className="max-w-xs">
        <Popover.Dialog className="text-muted text-xs leading-relaxed">
          {title && <p className="text-foreground mb-1 font-medium">{title}</p>}
          {children}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
