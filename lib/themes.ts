/**
 * Accent presets.
 *
 * Each preset changes exactly one thing: the `--accent` pair in globals.css,
 * selected by a `data-accent` attribute on <html>. Surfaces, spacing, radii and
 * the status colours are shared, so switching preset cannot alter layout or
 * make "running" and "deploying" harder to tell apart.
 *
 * `swatch` is the colour shown in the settings picker. It duplicates the value
 * in globals.css on purpose — the picker has to render the colour before the
 * preset is applied, so it cannot read it from a CSS variable.
 */

export const ACCENT_PRESETS = [
  {
    id: "mono",
    label: "Mono",
    description: "Nessun accento cromatico. L'azione primaria è bianca su nero e il colore compare solo negli stati.",
    swatch: "oklch(97% 0 0)",
  },
  {
    id: "blue",
    label: "Blu",
    description: "Blu freddo desaturato. Look da infrastruttura, molto leggibile.",
    swatch: "oklch(64% 0.14 245)",
  },
  {
    id: "teal",
    label: "Teal",
    description: "Verde-acqua desaturato, tenuto lontano dal verde di stato.",
    swatch: "oklch(72% 0.11 185)",
  },
  {
    id: "amber",
    label: "Ambra",
    description: "Accento caldo su base fredda.",
    swatch: "oklch(79% 0.13 72)",
  },
  {
    id: "violet",
    label: "Viola",
    description: "Il vecchio colore di RunPanel, ricalibrato per la palette neutra.",
    swatch: "oklch(66% 0.15 295)",
  },
] as const;

export type AccentPreset = (typeof ACCENT_PRESETS)[number]["id"];

export const DEFAULT_ACCENT: AccentPreset = "mono";

/** The settings key the chosen preset is stored under. */
export const ACCENT_SETTING_KEY = "accent_preset";

export function isAccentPreset(value: unknown): value is AccentPreset {
  return ACCENT_PRESETS.some((preset) => preset.id === value);
}

/** Narrow an arbitrary stored value to a usable preset id. */
export function resolveAccent(value: unknown): AccentPreset {
  return isAccentPreset(value) ? value : DEFAULT_ACCENT;
}
