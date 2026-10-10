"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { RouterProvider } from "@heroui/react";
import { addCollection } from "@iconify/react";
import { useRouter } from "next/navigation";
import { Toaster } from "sonner";
import { solarSubset } from "@/lib/icons.generated";
import { DEFAULT_ACCENT, type AccentPreset } from "@/lib/themes";
import {
  DEFAULT_THEME_MODE,
  THEME_COOKIE,
  applyPalette,
  systemPalette,
  type ThemeMode,
} from "@/lib/theme-mode";

// Registered at module scope so icons are available before the first render.
// Without this @iconify/react fetches every icon from api.iconify.design at
// runtime, which leaves a self-hosted panel on a private network with no icons
// at all. See scripts/build-icons.mjs.
addCollection(solarSubset);

interface AccentContextValue {
  accent: AccentPreset;
  setAccent: (preset: AccentPreset) => void;
}

const AccentContext = createContext<AccentContextValue>({
  accent: DEFAULT_ACCENT,
  setAccent: () => {},
});

/**
 * The active accent preset, seeded from the server so there is no first-paint
 * flash and no reading it back out of the DOM.
 */
export function useAccent(): AccentContextValue {
  return useContext(AccentContext);
}

interface ThemeModeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue>({
  mode: DEFAULT_THEME_MODE,
  setMode: () => {},
});

export function useThemeMode(): ThemeModeContextValue {
  return useContext(ThemeModeContext);
}

export function Providers({
  children,
  accent: initialAccent,
  themeMode: initialThemeMode,
}: {
  children: React.ReactNode;
  accent: AccentPreset;
  themeMode: ThemeMode;
}) {
  const router = useRouter();
  const [accent, setAccentState] = useState<AccentPreset>(initialAccent);

  const setAccent = useCallback((preset: AccentPreset) => {
    setAccentState(preset);
    // The CSS variables cascade from this attribute, so flipping it restyles
    // the page without re-rendering anything. setAttribute rather than a
    // dataset assignment keeps this a call, not a mutation of a foreign object.
    document.documentElement.setAttribute("data-accent", preset);
  }, []);

  const [themeMode, setThemeModeState] = useState<ThemeMode>(initialThemeMode);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    // A year, and Lax: it only picks a palette, it authorises nothing.
    document.cookie = `${THEME_COOKIE}=${mode}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.setAttribute("data-theme-mode", mode);
    applyPalette(mode === "system" ? systemPalette() : mode);
  }, []);

  // Follows the operating system while it is in charge, so switching the OS to
  // dark at sunset does not need a reload.
  useEffect(() => {
    if (themeMode !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyPalette(query.matches ? "light" : "dark");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [themeMode]);

  return (
    <ThemeModeContext.Provider value={{ mode: themeMode, setMode: setThemeMode }}>
    <AccentContext.Provider value={{ accent, setAccent }}>
      <RouterProvider navigate={router.push}>
        {children}
        {/*
          Toasts are styled from the same tokens as everything else instead of
          sonner's own palette, so they follow the active accent preset and do
          not reintroduce a second set of colours. `richColors` is off for that
          reason.
        */}
        <Toaster
          position="bottom-right"
          toastOptions={{
            classNames: {
              toast:
                "!bg-overlay !border !border-border !text-foreground !rounded-[var(--radius)] !shadow-overlay",
              description: "!text-muted",
              actionButton: "!bg-accent !text-accent-foreground",
              cancelButton: "!bg-default !text-foreground",
              success: "!text-success",
              error: "!text-danger",
            },
          }}
        />
      </RouterProvider>
    </AccentContext.Provider>
    </ThemeModeContext.Provider>
  );
}
