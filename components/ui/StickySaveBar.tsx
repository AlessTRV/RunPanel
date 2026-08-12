"use client";

import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";

/**
 * "You have unsaved changes", pinned where it cannot scroll away.
 *
 * The project settings tab had its Save button at line 444 of a 511-line
 * screen — halfway down, with two more panels below it that save independently.
 * Nothing about that says which fields it covers, and once the form got long
 * enough the button was simply off screen while you were editing.
 *
 * The autostart page had already found the better half of the answer: reveal
 * the action only when something is dirty, so a quiet page stays quiet. This
 * takes that and fixes the position — the bar is pinned to the bottom of the
 * viewport, so the distance between changing something and saving it no longer
 * depends on how far down the change happened to be.
 *
 * Rendered only while `isDirty`, rather than hidden with CSS: an offscreen
 * button that is still in the tab order is worse than no button.
 */
export function StickySaveBar({
  isDirty,
  isPending = false,
  onSave,
  onReset,
  message = "Modifiche non salvate",
  saveLabel = "Salva",
}: {
  isDirty: boolean;
  isPending?: boolean;
  onSave: () => void;
  onReset?: () => void;
  message?: string;
  saveLabel?: string;
}) {
  if (!isDirty) return null;

  return (
    <div
      role="status"
      className="sticky bottom-0 z-20 -mx-4 mt-2 sm:-mx-5"
    >
      <div className="border-border bg-overlay/95 mx-4 flex items-center gap-3 rounded-[var(--radius)] border px-4 py-3 backdrop-blur sm:mx-5">
        <Icon icon="solar:pen-new-square-linear" width={16} aria-hidden className="text-muted shrink-0" />
        <span className="text-muted min-w-0 flex-1 truncate text-sm">{message}</span>
        {onReset && (
          <Button variant="ghost" size="sm" isDisabled={isPending} onPress={onReset}>
            Annulla
          </Button>
        )}
        <Button size="sm" isPending={isPending} onPress={onSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
