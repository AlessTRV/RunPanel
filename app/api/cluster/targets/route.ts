import { NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { isVisible, visibleFolderIds, visibleProjectIds, visibleServiceIds } from "@/lib/principal";
import { signedFetch } from "@/services/cluster/client";
import { clusterState, listMembers } from "@/services/cluster/state";

interface Named {
  id: string;
  name: string;
}

export interface GrantTargets {
  folder: Named[];
  project: Named[];
  service: Named[];
  linkedService: Named[];
}

type RawService = { id: string; name: string; display_name: string | null; project_id: string | null };

/**
 * Everything a grant can point at, across the cluster, with the server's name
 * appended so two "api" projects on two servers can be told apart. Each
 * member answers for the signed-in user, so the lists are what they may see.
 */
export async function GET() {
  const denied = await requirePermission("users.manage");
  if (isDenied(denied)) return denied;

  const state = await clusterState();
  const members = state ? await listMembers() : [];
  const label = (name: string, member: string | null) => (member ? `${name} · ${member}` : name);

  const out: GrantTargets = { folder: [], project: [], service: [], linkedService: [] };
  const add = (lists: { folders: Named[]; projects: Named[]; services: RawService[] }, memberName: string | null) => {
    for (const f of lists.folders) out.folder.push({ id: f.id, name: label(f.name, memberName) });
    for (const p of lists.projects) out.project.push({ id: p.id, name: label(p.name, memberName) });
    for (const s of lists.services) {
      (s.project_id ? out.linkedService : out.service).push({ id: s.id, name: label(s.display_name || s.name, memberName) });
    }
  };

  // Local, straight from the store.
  const db = await getDb();
  const [folders, projects, services, vf, vp, vs] = await Promise.all([
    db.selectFrom("folders").select(["id", "name"]).orderBy("name").execute(),
    db.selectFrom("projects").select(["id", "name"]).orderBy("name").execute(),
    db.selectFrom("services").select(["id", "name", "display_name", "project_id"]).orderBy("name").execute(),
    visibleFolderIds(denied.principal),
    visibleProjectIds(denied.principal),
    visibleServiceIds(denied.principal),
  ]);
  const selfName = state ? (members.find((m) => m.id === state.selfId)?.name ?? null) : null;
  add(
    {
      folders: folders.filter((f) => isVisible(vf, f.id)),
      projects: projects.filter((p) => isVisible(vp, p.id)),
      services: services.filter((s) => isVisible(vs, s.id)),
    },
    members.length > 1 ? selfName : null
  );

  // The other members, each asked as this user.
  if (state) {
    const userId = denied.session.user.id;
    await Promise.all(
      members
        .filter((m) => m.id !== state.selfId)
        .map(async (m) => {
          try {
            const get = async <T,>(path: string): Promise<T | null> => {
              const res = await signedFetch(m, path, { userId, headersTimeoutMs: 5_000 });
              return res.ok ? ((await res.json()) as T) : null;
            };
            const [rf, rp, rs] = await Promise.all([get<Named[]>("/api/folders"), get<Named[]>("/api/projects"), get<RawService[]>("/api/services")]);
            add({ folders: rf ?? [], projects: rp ?? [], services: rs ?? [] }, m.name);
          } catch {
            // A member that is down simply contributes nothing to the pick list.
          }
        })
    );
  }

  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}
