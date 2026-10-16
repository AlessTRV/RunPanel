"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { nodeApiPath } from "@/lib/node-api";
import { isAggregatePath, serverFromSearch, withServer } from "@/lib/server-url";

/**
 * Which server of the cluster the pages are looking at.
 *
 * The answer lives in the URL (`?server=<memberId>`, see lib/server-url.ts),
 * so a link always opens on the server it was made on. A page about one thing
 * with no parameter is about this server; a list page with no parameter shows
 * every server. In solo mode there is nothing to choose and every helper here
 * is the identity.
 */

export interface NodeInfo {
  id: string;
  name: string;
  url: string;
  role: "panel" | "node";
  status: "unknown" | "ok" | "unreachable";
  version: string | null;
}

interface NodeContextValue {
  nodes: NodeInfo[];
  selfId: string | null;
  isSolo: boolean;
}

const NodeContext = createContext<NodeContextValue | null>(null);

export function NodeProvider({ nodes, selfId, children }: { nodes: NodeInfo[]; selfId: string | null; children: React.ReactNode }) {
  const isSolo = selfId === null || nodes.length < 2;
  const value = useMemo<NodeContextValue>(() => ({ nodes, selfId, isSolo }), [nodes, selfId, isSolo]);
  return <NodeContext.Provider value={value}>{children}</NodeContext.Provider>;
}

export interface UseNode extends NodeContextValue {
  /** The server named in the URL, or null (this server on a single page, every server on a list). */
  serverParam: string | null;
  /** The server a single-server page is about: the parameter, else this server. */
  selected: string | null;
  current: NodeInfo | null;
  isRemote: boolean;
  /** Change the server in the URL; null removes it. */
  select: (id: string | null) => void;
  nameOf: (id: string | null | undefined) => string;
}

export function useNode(): UseNode {
  const ctx = useContext(NodeContext);
  const base: NodeContextValue = ctx ?? { nodes: [], selfId: null, isSolo: true };
  const search = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const fromUrl = base.isSolo ? null : serverFromSearch(search);
  const serverParam = fromUrl && base.nodes.some((n) => n.id === fromUrl) ? fromUrl : null;
  const selected = base.isSolo ? base.selfId : (serverParam ?? base.selfId);
  const current = base.nodes.find((n) => n.id === selected) ?? null;

  const select = useCallback(
    (id: string | null) => {
      const query = search?.toString() ?? "";
      router.replace(withServer(`${pathname}${query ? `?${query}` : ""}`, id), { scroll: false });
    },
    [router, pathname, search]
  );

  const nameOf = useCallback((id: string | null | undefined) => base.nodes.find((n) => n.id === id)?.name ?? "", [base.nodes]);

  return {
    ...base,
    serverParam,
    selected,
    current,
    isRemote: selected !== null && selected !== base.selfId,
    select,
    nameOf,
  };
}

/** `api("/api/projects")` → the same path, or its forwarded form for the server this page is about. */
export function useNodeApi(): (path: string) => string {
  const { selected, selfId } = useNode();
  return useCallback((path: string) => nodeApiPath(selected, selfId, path), [selected, selfId]);
}

/** API paths for an explicit member: the rows of an aggregated list each live on their own server. */
export function useMemberApi(): (memberId: string | null | undefined, path: string) => string {
  const { selfId } = useNode();
  return useCallback((memberId, path) => nodeApiPath(memberId ?? null, selfId, path), [selfId]);
}

/**
 * Links that stay on a server. `href("/projects/x")` carries the server of the
 * current page; `href("/projects/x", memberId)` names one explicitly. On a list
 * page with no server named, links to other list pages keep showing everything.
 */
export function useServerHref(): (href: string, memberId?: string | null) => string {
  const { isSolo, serverParam, selfId } = useNode();
  return useCallback(
    (href: string, memberId?: string | null) => {
      if (isSolo) return href;
      const target = memberId === undefined ? serverParam : memberId;
      // This server needs no parameter on a single page; on a list it would narrow it.
      const path = href.split(/[?#]/)[0];
      if (target === selfId && !isAggregatePath(path)) return withServer(href, null);
      return withServer(href, target);
    },
    [isSolo, serverParam, selfId]
  );
}
