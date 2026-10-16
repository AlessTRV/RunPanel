"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { nodeApiPath } from "@/lib/node-api";

/**
 * Which server of the cluster the pages are looking at.
 *
 * The panel layout hands down the member list and this install's own id; the
 * selection lives in the browser (one per device, like the theme) and every
 * page routes its API calls through `useNodeApi()`, which forwards them to
 * the selected member when it is not this one. In solo mode there is nothing
 * to select and the helper is the identity.
 *
 * The stored choice is read through `useSyncExternalStore`, so the server
 * render and the hydration pass both see "this server" and the browser's
 * choice applies right after, without a state update inside an effect.
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
  selected: string | null;
  select: (id: string) => void;
  isSolo: boolean;
}

const STORAGE_KEY = "runpanel:selected-node";

const NodeContext = createContext<NodeContextValue | null>(null);

const listeners = new Set<() => void>();

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function serverSnapshot(): string | null {
  return null;
}

export function NodeProvider({ nodes, selfId, children }: { nodes: NodeInfo[]; selfId: string | null; children: React.ReactNode }) {
  const isSolo = selfId === null || nodes.length < 2;
  const stored = useSyncExternalStore(subscribe, readStored, serverSnapshot);
  const selected = !isSolo && stored && nodes.some((n) => n.id === stored) ? stored : selfId;

  const select = useCallback((id: string) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* private window, or storage blocked: nothing to remember */
    }
    for (const callback of listeners) callback();
  }, []);

  const value = useMemo<NodeContextValue>(() => ({ nodes, selfId, selected, select, isSolo }), [nodes, selfId, selected, select, isSolo]);
  return <NodeContext.Provider value={value}>{children}</NodeContext.Provider>;
}

export function useNode(): NodeContextValue & { current: NodeInfo | null; isRemote: boolean } {
  const ctx = useContext(NodeContext);
  const base: NodeContextValue = ctx ?? { nodes: [], selfId: null, selected: null, select: () => undefined, isSolo: true };
  const current = base.nodes.find((n) => n.id === base.selected) ?? null;
  return { ...base, current, isRemote: base.selected !== null && base.selected !== base.selfId };
}

/** `api("/api/projects")` → the same path, or its forwarded form for the selected member. */
export function useNodeApi(): (path: string) => string {
  const { selected, selfId } = useNode();
  return useCallback((path: string) => nodeApiPath(selected, selfId, path), [selected, selfId]);
}
