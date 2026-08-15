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
 *
 * Below `md` it sits ABOVE the mobile navigation rather than under it. Pinning
 * it to `bottom-0` put it behind that bar, which is fixed and paints later —
 * so on a phone the save button was hidden by the thing covering the bottom of
 * every screen. `main`'s `pb-24` does not help: a sticky offset is measured
 * from the scrollport, not from the container's padding box.
 *
 * 4.75rem is measured, not derived: adding up MobileNav's padding, icon, label
 * and underline predicts 59px, but the bar actually lays out at 67px, so a
 * 4rem offset left it overlapping by three. 76px clears the real height with
 * ~9px of air, so it reads as floating above rather than welded to it.
 * `env(safe-area-inset-bottom)` matches the padding MobileNav already applies
 * on top of that height, and is 0 on a device without a notch.
 *
 * The z-index stays at 20 deliberately. Raising it is the wrong instinct: the
 * drawer's backdrop is z-40, and this bar would tie it and win on DOM order,
 * leaving an unsaved-changes bar floating over the dimmed overlay while the
 * navigation drawer is open. With the offset it no longer overlaps the tab bar
 * at all, so their relative order stops mattering.
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
      className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-20 -mx-4 mt-2 sm:-mx-5 md:bottom-0"
    >
      <div className="border-border bg-overlay/95 shadow-overlay mx-4 flex items-center gap-3 rounded-[var(--radius)] border px-4 py-3 backdrop-blur sm:mx-5">
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
