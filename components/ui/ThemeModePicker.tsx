"use client";

import { useThemeMode } from "@/components/Providers";
import { THEME_MODES, type ThemeMode } from "@/lib/theme-mode";
import { Segmented } from "./Segmented";

/** Chiaro, Scuro or Sistema, for this browser only — see lib/theme-mode.ts. */
export function ThemeModePicker() {
  const { mode, setMode } = useThemeMode();
  return (
    <Segmented<ThemeMode>
      label="Tema"
      value={mode}
      onChange={setMode}
      options={THEME_MODES.map((m) => ({ value: m.id, label: m.label }))}
    />
  );
}
