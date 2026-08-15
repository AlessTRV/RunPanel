"use client";

import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

/**
 * Choose one of a few. The single recipe.
 *
 * This was the most duplicated idea in the panel: four incompatible visual
 * treatments for the same interaction. A `Button variant={active ? "primary" :
 * "outline"}` loop in the project settings and the app wizard; a bordered
 * icon-card for the runtime picker; a local `segment()` helper used six times
 * inside the backup policy form; and a third inline pill recipe in storage,
 * account and the accent picker. None shared code, and none agreed on what
 * "selected" looks like — so the same gesture read differently depending on
 * which screen you were on.
 *
 * The structure is HeroUI's; the selected look is now the app's, and the two
 * are set in different places on purpose.
 *
 * An earlier note here claimed the library could not be restyled short of
 * `!important`, because it "composes a caller's className BEFORE its slot
 * classes". That was wrong twice over: `compose.js` does `cx(tw, cls)`, so the
 * caller's classes go last — and the order of names in a class attribute has
 * never affected the cascade anyway. What actually defeated those attempts is
 * that React Aria emits `data-selected` only when it is true, so a
 * `data-[selected=false]:…` variant never matches, while an unconditional
 * class makes every segment look chosen.
 *
 * So the selected state is set in app/globals.css instead, through the
 * variables HeroUI exposes for it, next to the same recipe the sidebar and the
 * command palette use. It has to live there rather than here regardless: this
 * component cannot reach `:focus-visible`, and the focus ring is the one thing
 * that must not be painted over.
 *
 * Built on ToggleButtonGroup so arrow-key roving focus, `role="radiogroup"` and
 * the selected state come from the library too. `disallowEmptySelection`
 * because every use here is "pick one", never "pick none".
 */

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Iconify name. Keep it a literal — the icon bundler greps for these. */
  icon?: string;
  isDisabled?: boolean;
}

/** Layout only. The selected state is set in app/globals.css — see above. */
const ITEM = "flex items-center gap-1.5 text-sm";

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly SegmentedOption<T>[];
  /** Accessible name for the group — required when there is no visible label. */
  label?: string;
  className?: string;
}) {
  return (
    <ToggleButtonGroup
      isDetached
      selectionMode="single"
      disallowEmptySelection
      aria-label={label}
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const next = [...keys][0];
        if (typeof next === "string") onChange(next as T);
      }}
      className={cn("flex flex-wrap gap-2", className)}
    >
      {options.map((option) => (
        <ToggleButton
          key={option.value}
          id={option.value}
          isDisabled={option.isDisabled}
          className={ITEM}
        >
          {option.icon && <Icon icon={option.icon} width={15} aria-hidden />}
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

/**
 * Choose any number. Same shape, so the two never look like different controls
 * — the backup policy form needs both a minute apart.
 */
export function SegmentedMulti<T extends string>({
  values,
  onChange,
  options,
  label,
  className,
}: {
  values: readonly T[];
  onChange: (next: T[]) => void;
  options: readonly SegmentedOption<T>[];
  label?: string;
  className?: string;
}) {
  return (
    <ToggleButtonGroup
      isDetached
      selectionMode="multiple"
      aria-label={label}
      selectedKeys={values}
      onSelectionChange={(keys) => onChange([...keys] as T[])}
      className={cn("flex flex-wrap gap-2", className)}
    >
      {options.map((option) => (
        <ToggleButton
          key={option.value}
          id={option.value}
          isDisabled={option.isDisabled}
          className={ITEM}
        >
          {option.icon && <Icon icon={option.icon} width={15} aria-hidden />}
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
