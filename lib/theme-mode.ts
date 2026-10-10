/**
 * Light, dark or whatever the operating system says.
 *
 * Per browser rather than per panel, unlike the accent: the same panel is opened
 * from a phone in the sun and from a desk at night, and one person's choice
 * should not flip the screen of another. A cookie rather than localStorage so
 * the server renders the right palette in the first paint.
 *
 * `system` cannot be resolved on the server. The page is rendered dark and a
 * blocking script in <head> (`THEME_BOOT_SCRIPT`) swaps it before the first
 * paint when the system prefers light.
 */

export const THEME_MODES = [
  { id: "light", label: "Chiaro" },
  { id: "dark", label: "Scuro" },
  { id: "system", label: "Sistema" },
] as const;

export type ThemeMode = (typeof THEME_MODES)[number]["id"];

export const DEFAULT_THEME_MODE: ThemeMode = "dark";

export const THEME_COOKIE = "runpanel_theme";

export function resolveThemeMode(value: unknown): ThemeMode {
  return THEME_MODES.some((mode) => mode.id === value) ? (value as ThemeMode) : DEFAULT_THEME_MODE;
}

/** The palette a mode stands for on the server, where `system` is unknown. */
export function serverPalette(mode: ThemeMode): "light" | "dark" {
  return mode === "light" ? "light" : "dark";
}

/**
 * Sets `data-theme` and the `dark` class on <html>. HeroUI reads both: the class
 * drives its `dark:` variant, the attribute selects the token block.
 */
export function applyPalette(palette: "light" | "dark"): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", palette);
  root.classList.toggle("dark", palette === "dark");
}

export function systemPalette(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Inlined in <head>; must stay self-contained and never throw. */
export const THEME_BOOT_SCRIPT = `(function(){try{var e=document.documentElement;if(e.getAttribute("data-theme-mode")!=="system")return;var l=window.matchMedia("(prefers-color-scheme: light)").matches;e.setAttribute("data-theme",l?"light":"dark");e.classList.toggle("dark",!l);}catch(_){}})();`;
