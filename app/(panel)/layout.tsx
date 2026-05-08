import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppSidebar } from "@/components/AppSidebar";
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
    <div className="min-h-screen bg-transparent">
      <AppSidebar />
      <div className="ml-0 md:ml-64">
        <TopBar />
        <main className="pt-4 md:pt-8 pb-8 px-4 sm:px-8 md:px-12">{children}</main>
      </div>
    </div>
  );
}
