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
 *
 * Everything visible lives inside `Switch.Content`, and that is not a detail.
 * HeroUI 3.2 split the component in two: the root is now React Aria's
 * `SwitchField`, a plain `<div>` that carries state and nothing else, and
 * `Switch.Content` is the `SwitchButton` — the `<label>` holding the hidden
 * checkbox and every press, hover and focus handler. Children written straight
 * under the root, the way 3.0 wanted them, still render and still look exactly
 * right; they are simply outside the label, so the switch is scenery. That was
 * this file before: eight settings across the panel that could be clicked at
 * and never changed, with no error to show for it because no handler had run.
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
      className={cn("w-full", className)}
    >
      <Switch.Content className="flex w-full items-start justify-between gap-3">
        {/*
          `font-normal` undoes `.switch__content`, which is `font-medium`
          because HeroUI expects a short `Label` there and nothing else. A
          panel setting carries a sentence of description under its label,
          and at medium weight the two stop reading as label and gloss.
        */}
        <span className="min-w-0 flex-1 font-normal">
          <span className="text-foreground block text-sm">{label}</span>
          {description && (
            <span className="text-muted mt-0.5 block text-meta leading-relaxed">{description}</span>
          )}
        </span>

        {/*
          The track and the thumb, explicitly.

          HeroUI's Switch renders whatever children it is given and nothing
          else — it supplies behaviour and ARIA, not a picture. Passing only a
          label produced a control that was fully working and completely
          invisible: pressable, announced correctly by a screen reader, and
          showing no state at all to anyone looking at it.
        */}
        <Switch.Control className="mt-0.5 shrink-0">
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
}
