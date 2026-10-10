import { NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { projectAccess, serviceAccess } from "@/lib/authz";
import { projectRefs, serviceRefs } from "@/lib/principal";
import { targetsCache } from "@/services/backup/catalog";

/**
 * What a policy can be pointed at. Anyone but the owner is offered only the
 * projects and services they manage — the only ones `lib/backup-access.ts`
 * lets them put in a policy.
 */
export async function GET() {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;

  const catalog = await targetsCache.get();
  if (denied.principal.isOwner) return NextResponse.json(catalog);

  const projects = await projectRefs();
  const services = await serviceRefs(projects);
  const manages = (level: string | null) => level === "manage";
  return NextResponse.json({
    ...catalog,
    projects: catalog.projects.filter((p) => {
      const ref = projects.get(p.id);
      return ref !== undefined && manages(projectAccess(denied.principal, ref).level);
    }),
    services: catalog.services.filter((s) => {
      const ref = services.get(s.id);
      return ref !== undefined && manages(serviceAccess(denied.principal, ref).level);
    }),
  });
}
