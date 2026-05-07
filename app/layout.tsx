import type { Metadata } from "next";
import { Providers } from "@/components/Providers";
import { Background } from "@/components/Background";
import "./globals.css";

export const metadata: Metadata = {
  title: "RunPanel",
  description: "Self-hosted deployment panel",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>
        <Background />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
