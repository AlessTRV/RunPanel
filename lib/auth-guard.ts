import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { getSession, type SessionInfo } from "./auth";
import { verifySignedHeaders } from "./cluster-auth";
import type { ClusterMembersTable } from "./db/schema";
import {
  PROJECT_ACTIONS,
  SERVICE_ACTIONS,
  folderAccess,
  hasPermission,
  projectAccess,
  satisfies,
  serviceAccess,
  type Access,
  type GlobalPermission,
  type Principal,
  type ProjectAction,
  type ServiceAction,
} from "./authz";
import { loadPrincipal, projectRef, serviceRef } from "./principal";

/**
 * The guards every route handler starts with.
 *
 * Each returns either the response to send back (401, 403, 404) or the context
 * the handler needs. There is deliberately no "just signed in" guard besides
 * `requireUser`, and `authz-coverage-unit` fails the build of any handler that
 * calls none of these: a route has to say what it protects.
 *
 *   401  no valid session
 *   403  signed in, but the action or the panel-wide permission is not theirs —
 *        or the migrated owner has not set an email yet
 *   404  the project or service does not exist OR is invisible to them: a
 *        user must not learn that a project they were not given exists
 */

export interface AuthContext {
  session: SessionInfo;
  principal: Principal;
}

export function isDenied(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}

const unauthorized = () => NextResponse.json({ error: "Non autorizzato" }, { status: 401 });
const forbidden = (error = "Non hai il permesso per questa operazione") => NextResponse.json({ error }, { status: 403 });
const notFound = (what: string) => NextResponse.json({ error: `${what} non trovato` }, { status: 404 });

export async function requireUser(opts: { allowMissingEmail?: boolean } = {}): Promise<NextResponse | AuthContext> {
  const session = await getSession();
  if (!session) return unauthorized();
  if (!session.user.email && !opts.allowMissingEmail) {
    return NextResponse.json(
      { error: "Imposta la tua email per continuare", code: "email_required" },
      { status: 403 }
    );
  }
  return { session, principal: await loadPrincipal(session.user) };
}

export async function requireOwner(): Promise<NextResponse | AuthContext> {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  return ctx.principal.isOwner ? ctx : forbidden("Solo il proprietario può farlo");
}

export async function requirePermission(permission: GlobalPermission): Promise<NextResponse | AuthContext> {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  return hasPermission(ctx.principal, permission) ? ctx : forbidden();
}

export async function requireProject(
  projectId: string,
  action: ProjectAction
): Promise<NextResponse | (AuthContext & { access: Access })> {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const ref = await projectRef(projectId);
  if (!ref) return notFound("Progetto");
  const access = projectAccess(ctx.principal, ref);
  if (access.level === null) return notFound("Progetto");
  if (!satisfies(access, PROJECT_ACTIONS[action])) return forbidden();
  return { ...ctx, access };
}

export async function requireService(
  serviceId: string,
  action: ServiceAction
): Promise<NextResponse | (AuthContext & { access: Access })> {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const ref = await serviceRef(serviceId);
  if (!ref) return notFound("Servizio");
  const access = serviceAccess(ctx.principal, ref);
  if (access.level === null) return notFound("Servizio");
  if (!satisfies(access, SERVICE_ACTIONS[action])) return forbidden();
  return { ...ctx, access };
}

export interface MemberContext {
  member: ClusterMembersTable;
  /** The user the calling panel acts for, when it does. */
  userId: string | null;
}

/**
 * For the few endpoints another member of the cluster calls directly — ping,
 * directory exchange, leave — which carry a signature and no cookie. `role`
 * narrows them to panels: a managed node is never allowed to push a directory.
 */
export async function requireMember(opts: { role?: "panel" } = {}): Promise<NextResponse | MemberContext> {
  const requestHeaders = await headers();
  const caller = await verifySignedHeaders((name) => requestHeaders.get(name));
  if (!caller) return unauthorized();
  if (opts.role && caller.member.role !== opts.role) return forbidden("Solo un pannello può farlo");
  return caller;
}

/** For folders: renaming or deleting one needs `manage` on it (or on everything). */
export async function requireFolder(folderId: string): Promise<NextResponse | AuthContext> {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const access = folderAccess(ctx.principal, folderId);
  if (access.level === null) return notFound("Cartella");
  return access.level === "manage" ? ctx : forbidden();
}
