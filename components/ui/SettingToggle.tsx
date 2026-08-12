"use client";

import { Switch } from "@heroui/react";
import { cn } from "@/lib/utils";

/**
 * A setting that is on or off.
 *
 * `SettingsTab` had grown its own `role="switch"` button — hand-rolled ARIA,
 * hand-rolled focus ring, hand-rolled thumb animation — while HeroUI shipped a
 * Switch the whole time. Three uses in one file, and nothing to reach for
 * anywhere else, which is why the same idea appeared as a pair of segmented
 * buttons on other screens.
 *
 * `description` sits under the label rather than beside it: at `text-meta` it is
 * the thing that lets a toggle replace a sentence of explanation, which is most
 * of how the always-visible hints get retired.
 */
export function SettingToggle({
  label,
  description,
  isSelected,
  onChange,
  isDisabled = false,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  isSelected: boolean;
  onChange: (next: boolean) => void;
  isDisabled?: boolean;
  className?: string;
}) {
  return (
    <Switch
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
      className={cn("flex w-full items-start justify-between gap-3", className)}
    >
      <span className="min-w-0 flex-1">
        <span className="text-foreground block text-sm">{label}</span>
        {description && (
          <span className="text-muted mt-0.5 block text-meta leading-relaxed">{description}</span>
        )}
      </span>

      {/*
        The track and the thumb, explicitly.

        HeroUI's Switch root renders whatever children it is given and nothing
        else — it supplies behaviour and ARIA, not a picture. Passing only a
        label produced a control that was fully working and completely
        invisible: pressable, announced correctly by a screen reader, and
        showing no state at all to anyone looking at it.
      */}
      <Switch.Control className="mt-0.5 shrink-0">
        <Switch.Thumb />
      </Switch.Control>
    </Switch>
  );
}
