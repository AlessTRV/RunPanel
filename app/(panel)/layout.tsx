import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppSidebar } from "@/components/AppSidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { TopBar } from "@/components/TopBar";

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
    <div className="min-h-dvh">
      <AppSidebar />
      <div className="md:ml-64">
        <TopBar />
        {/* Capped so tables and lists do not stretch to absurd line lengths on
            a wide monitor, which is most of what makes a panel feel unplanned. */}
        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
      {/* Mounted once for the whole panel: it listens for Ctrl/Cmd+K and
          renders nothing until it is asked for. */}
      <CommandPalette />
    </div>
  );
}
