"use client";

import { Checkbox, Description } from "@heroui/react";
import { cn } from "@/lib/utils";

/**
 * A tick box with its label, for choices inside a list or a form row.
 *
 * `SettingToggle` stays the control for a setting that is on or off; this is
 * for "include this one", where a switch would promise an effect that only
 * happens when the form is saved. It replaces the native checkboxes, which were
 * 13px squares with no focus ring of the theme's and a label that was not
 * always clickable.
 *
 * Everything clickable sits inside `Checkbox.Content`, the same rule as
 * `Switch` in HeroUI 3.2: outside it, the label renders and does nothing.
 */
export function CheckboxField({
  label,
  description,
  isSelected,
  onChange,
  isDisabled,
  ariaLabel,
  className,
}: {
  /** Visible label. Without one, pass `ariaLabel`. */
  label?: React.ReactNode;
  description?: React.ReactNode;
  isSelected: boolean;
  onChange: (next: boolean) => void;
  isDisabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <Checkbox
      isSelected={isSelected}
      onChange={onChange}
      isDisabled={isDisabled}
      aria-label={label ? undefined : ariaLabel}
      variant="secondary"
      className={cn("min-w-0", className)}
    >
      {/* HeroUI sets the label in medium weight; here it is body text. */}
      <Checkbox.Content className="text-foreground min-w-0 text-sm font-normal">
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        {label}
      </Checkbox.Content>
      {description && <Description className="text-muted text-xs">{description}</Description>}
    </Checkbox>
  );
}
