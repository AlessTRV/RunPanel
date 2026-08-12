import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppSidebar } from "@/components/AppSidebar";
import { MobileNav } from "@/components/MobileNav";
import { CommandPalette } from "@/components/CommandPalette";
import { TopBar } from "@/components/TopBar";
import { PollingProvider } from "@/lib/hooks/usePollingInterval";

export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  return (
    <PollingProvider>
    <div className="min-h-dvh">
      <AppSidebar />
      <MobileNav />
      <div className="md:ml-64">
        <TopBar />
        {/* Capped so tables and lists do not stretch to absurd line lengths on
            a wide monitor, which is most of what makes a panel feel unplanned.

            The bottom padding below `md` clears the navigation bar: without it
            the last row of every list sits underneath it, and on a long page
            that is the row you scrolled down to reach. */}
        <main className="mx-auto w-full max-w-[1400px] px-4 pt-6 pb-24 sm:px-6 md:pb-6 lg:px-8">
          {children}
        </main>
      </div>
      {/* Mounted once for the whole panel: it listens for Ctrl/Cmd+K and
          renders nothing until it is asked for. */}
      <CommandPalette />
    </div>
    </PollingProvider>
  );
}
