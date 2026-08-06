import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/Providers";
import { Background } from "@/components/Background";
import { getSetting } from "@/lib/settings";
import { ACCENT_SETTING_KEY, DEFAULT_ACCENT, resolveAccent } from "@/lib/themes";
import "./globals.css";

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-app-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
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
  themeColor: "#09090b",
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

  return (
    <html
      lang="it"
      className={`dark ${sans.variable} ${mono.variable}`}
      data-accent={accent}
      suppressHydrationWarning
    >
      <body>
        <Background />
        <Providers accent={accent}>{children}</Providers>
      </body>
    </html>
  );
}
