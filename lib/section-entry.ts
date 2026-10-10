import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/authz";
import { loadPrincipal } from "@/lib/principal";
import { NAV_SECTIONS, passesNavPermission, type NavSectionId } from "@/lib/nav";

/**
 * `/system` and `/access` are sidebar entries, not pages: they send the reader
 * to the first tab they may open. Resolved on the server so the redirect is a
 * single hop, with no page that flashes and moves.
 */
export async function redirectToSection(section: NavSectionId): Promise<never> {
  const session = await getSession();
  if (!session) redirect("/login");
  const principal = await loadPrincipal(session.user);
  const first = NAV_SECTIONS[section].tabs.find((tab) =>
    passesNavPermission(tab.permission, (p) => hasPermission(principal, p))
  );
  redirect(first?.href ?? "/home");
}
