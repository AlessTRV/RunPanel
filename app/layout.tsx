import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { Providers } from "@/components/Providers";
import { Background } from "@/components/Background";
import { getSetting } from "@/lib/settings";
import { ACCENT_SETTING_KEY, DEFAULT_ACCENT, resolveAccent } from "@/lib/themes";
import { THEME_BOOT_SCRIPT, THEME_COOKIE, resolveThemeMode, serverPalette } from "@/lib/theme-mode";
import "./globals.css";

const sans = Geist({
  subsets: ["latin"],
  variable: "--font-app-sans",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-app-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "RunPanel",
    template: "%s · RunPanel",
  },
  description: "Self-hosted deployment panel",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9fafb" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0c10" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Resolved on the server so the attribute is already correct in the first
  // paint — a client-side theme switch would flash the default preset first.
  // A store that is not reachable yet must not take the whole page down, so
  // fall back to the default rather than throwing.
  let accent = DEFAULT_ACCENT;
  try {
    accent = resolveAccent(await getSetting(ACCENT_SETTING_KEY));
  } catch {
    /* first run, or the store is still starting up */
  }

  const themeMode = resolveThemeMode((await cookies()).get(THEME_COOKIE)?.value);
  const palette = serverPalette(themeMode);

  return (
    <html
      lang="it"
      className={`${palette === "dark" ? "dark " : ""}${sans.variable} ${mono.variable}`}
      data-accent={accent}
      data-theme={palette}
      data-theme-mode={themeMode}
      suppressHydrationWarning
    >
      <head>
        {/* Before anything paints: resolves "Sistema" to the OS palette, which
            the server cannot know. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <Background />
        <Providers accent={accent} themeMode={themeMode}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
