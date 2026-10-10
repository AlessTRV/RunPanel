"use client";

import { Label, ListBox, Select } from "@heroui/react";
import { cn } from "@/lib/utils";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** A second line in the list, never in the closed field. */
  description?: string;
  isDisabled?: boolean;
}

/**
 * A pick-one list, the HeroUI way.
 *
 * Replaces the native `<select>`s that had grown in ten places with three
 * different class recipes between them — different heights, borders and focus
 * rings depending on which file you were in, and a dark-on-dark dropdown on
 * Windows that the theme could not reach at all.
 *
 * Values are strings in and out. React Aria's `Key` is `string | number`; every
 * call site here stores a string, and converting once in this file is cheaper
 * than a `String()` at each of them.
 */
export function SelectField<T extends string>({
  label,
  ariaLabel,
  value,
  onChange,
  options,
  placeholder = "Scegli…",
  isDisabled,
  isInvalid,
  className,
}: {
  /** Visible label. Without one, pass `ariaLabel`. */
  label?: React.ReactNode;
  ariaLabel?: string;
  value: T | null;
  onChange: (next: T) => void;
  options: readonly SelectOption<T>[];
  placeholder?: string;
  isDisabled?: boolean;
  isInvalid?: boolean;
  className?: string;
}) {
  return (
    <Select
      className={cn("w-full", className)}
      aria-label={label ? undefined : ariaLabel}
      placeholder={placeholder}
      value={value}
      onChange={(next) => {
        if (next === null || Array.isArray(next)) return;
        onChange(String(next) as T);
      }}
      disabledKeys={options.filter((o) => o.isDisabled).map((o) => o.value)}
      isDisabled={isDisabled}
      isInvalid={isInvalid}
      variant="secondary"
      fullWidth
    >
      {label && <Label>{label}</Label>}
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              {option.description ? (
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{option.label}</span>
                  <span className="text-muted truncate text-xs">{option.description}</span>
                </span>
              ) : (
                option.label
              )}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
