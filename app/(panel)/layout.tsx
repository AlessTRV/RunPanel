import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GLOBAL_PERMISSIONS, hasPermission } from "@/lib/authz";
import { loadPrincipal } from "@/lib/principal";
import { MeProvider } from "@/lib/hooks/useMe";
import { NodeProvider, type NodeInfo } from "@/lib/hooks/useNode";
import { clusterState, listMembers } from "@/services/cluster/state";
import { AppSidebar } from "@/components/AppSidebar";
import { MobileNav } from "@/components/MobileNav";
import { CommandPalette } from "@/components/CommandPalette";
import { TopBar } from "@/components/TopBar";
import { PollingProvider } from "@/lib/hooks/usePollingInterval";
import { PanelUpdateProvider } from "@/lib/hooks/usePanelUpdate";
import { UpdateBanner } from "@/components/UpdateBanner";
import { panelRelease } from "@/services/panel-update/release";

export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  // The owner migrated from the single password signs in without an email and
  // sets one before anything else.
  if (!session.user.email) {
    redirect("/setup-email");
  }
  const principal = await loadPrincipal(session.user);
  const me = {
    id: session.user.id,
    email: session.user.email,
    isOwner: session.user.isOwner,
    permissions: GLOBAL_PERMISSIONS.filter((p) => hasPermission(principal, p)),
  };

  // The other servers of the cluster, for the selector. Empty in solo mode.
  const cluster = await clusterState();
  const nodes: NodeInfo[] = cluster
    ? (await listMembers()).map((m) => ({
        id: m.id,
        name: m.name,
        url: m.url,
        role: m.role === "node" ? "node" : "panel",
        status: m.id === cluster.selfId ? "ok" : m.status === "ok" || m.status === "unreachable" ? m.status : "unknown",
        version: m.version,
      }))
    : [];

  return (
    <MeProvider me={me}>
    <NodeProvider nodes={nodes} selfId={cluster?.selfId ?? null}>
    <PollingProvider>
    <PanelUpdateProvider>
    <div className="min-h-dvh">
      <AppSidebar version={(await panelRelease()).label} />
      <MobileNav />
      <div className="md:ml-64">
        <TopBar />
        {/* Under the bar and in the flow, never above it and never fixed: the
            mobile menu button is fixed in the top-right corner and the TopBar
            reserves space for it, so a strip above would end up beneath it. */}
        <UpdateBanner />
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
    </PanelUpdateProvider>
    </PollingProvider>
    </NodeProvider>
    </MeProvider>
  );
}
