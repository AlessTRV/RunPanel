import { isClusterSession } from "./auth";
import { getDb } from "./db";
import {
  PROJECT_ACTIONS,
  SERVICE_ACTIONS,
  hasPermission,
  projectAccess,
  satisfies,
  serviceAccess,
  type GlobalPermission,
  type Principal,
  type ProjectAction,
  type ServiceAction,
} from "./authz";
import { loadPrincipal, projectRef, serviceRef } from "./principal";
import { authzEvents } from "@/services/events";

/**
 * Keep checking access for things that stay open: SSE streams and shells.
 *
 * A route guard runs once, when the request arrives. A stream opened before a
 * grant was removed would otherwise keep delivering a project's logs for as
 * long as the tab stays open, and a container shell would keep accepting
 * input. Every write that changes what a user can reach emits on
 * `authzEvents` (see lib/users.ts and lib/auth.ts); this listens on the user's
 * channel, re-reads the account and calls `onLost` once access is gone.
 */

const RECHECK_MS = 60_000;

export type AccessCheck = (principal: Principal) => Promise<boolean>;

export function projectAllows(projectId: string, action: ProjectAction): AccessCheck {
  return async (principal) => {
    const ref = await projectRef(projectId);
    return ref !== null && satisfies(projectAccess(principal, ref), PROJECT_ACTIONS[action]);
  };
}

export function serviceAllows(serviceId: string, action: ServiceAction): AccessCheck {
  return async (principal) => {
    const ref = await serviceRef(serviceId);
    return ref !== null && satisfies(serviceAccess(principal, ref), SERVICE_ACTIONS[action]);
  };
}

export function permissionAllows(permission: GlobalPermission): AccessCheck {
  return async (principal) => hasPermission(principal, permission);
}

/**
 * `sessionId` ties the watch to one signed-in device: revoking that session
 * ends it. A shell is the user's rather than one device's, so it passes none
 * and only ends when the account or its access changes.
 */
export function watchAccess(
  who: { userId: string; sessionId?: string },
  allowed: AccessCheck,
  onLost: () => void
): () => void {
  let stopped = false;

  const lose = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    onLost();
  };

  const recheck = async () => {
    try {
      const db = await getDb();
      const user = await db
        .selectFrom("users")
        .select(["id", "email", "is_owner", "disabled"])
        .where("id", "=", who.userId)
        .executeTakeFirst();
      if (!user || user.disabled === 1) return lose();
      // A request forwarded by another panel has no `sessions` row here: the
      // signature was its session, and it was checked when the stream opened.
      if (who.sessionId && !isClusterSession(who.sessionId)) {
        const session = await db.selectFrom("sessions").select("id").where("id", "=", who.sessionId).executeTakeFirst();
        if (!session) return lose();
      }
      const principal = await loadPrincipal({ id: user.id, email: user.email, isOwner: user.is_owner === 1 });
      if (!(await allowed(principal))) lose();
    } catch {
      // Unable to confirm is not confirmed.
      lose();
    }
  };

  const unsubscribe = authzEvents.subscribe(who.userId, (event) => {
    if (stopped) return;
    if (event.type === "session-revoked") {
      if (who.sessionId && event.sessionId === who.sessionId) lose();
      return;
    }
    void recheck();
  });

  // A backstop for changes that emit nothing: every minute, look again.
  const timer = setInterval(() => {
    if (!stopped) void recheck();
  }, RECHECK_MS);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
  };
}
