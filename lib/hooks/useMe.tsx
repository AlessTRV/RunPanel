"use client";

import { createContext, useCallback, useContext } from "react";
import type { GlobalPermission } from "@/lib/authz";
import { passesNavPermission, type NavPage } from "@/lib/nav";

/**
 * Who is signed in and which panel-wide permissions they hold, handed down by
 * the panel layout so no page has to fetch it.
 *
 * For hiding what someone cannot use — never for protecting it: every route
 * checks again on the server. Per-project levels come with the project itself
 * (`permission` on `GET /api/projects/:id` and `GET /api/services/:id`).
 */
export interface Me {
  id: string;
  email: string | null;
  isOwner: boolean;
  permissions: readonly GlobalPermission[];
}

const MeContext = createContext<Me | null>(null);

export function MeProvider({ me, children }: { me: Me; children: React.ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): Me {
  const me = useContext(MeContext);
  // Outside the panel layout nothing is granted, which is the safe reading.
  return me ?? { id: "", email: null, isOwner: false, permissions: [] };
}

/** Whether the signed-in user holds a panel-wide permission (the owner holds all). */
export function useCan(permission: GlobalPermission): boolean {
  const me = useMe();
  return me.isOwner || me.permissions.includes(permission);
}

/** A filter for navigation entries: those whose permission the user holds. */
export function useAllowedNav(): (item: NavPage) => boolean {
  const me = useContext(MeContext);
  return useCallback(
    (item: NavPage) =>
      Boolean(me?.isOwner) ||
      passesNavPermission(item.permission, (p) => Boolean(me?.permissions.includes(p))),
    [me]
  );
}
