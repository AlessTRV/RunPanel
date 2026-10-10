"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Names for the URL segments the breadcrumb cannot name by itself.
 *
 * The trail is built from the pathname, so a project page read
 * "Progetti / jyEXZID85HCt". The page knows the name; it hands it over here and
 * the TopBar, which lives in the layout and has no way to ask, picks it up.
 * Module state rather than context: the two are siblings, not parent and child.
 */
const labels = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by a page: names `segment` in the trail while the page is mounted. */
export function useCrumbLabel(segment: string | undefined, label: string | null | undefined): void {
  useEffect(() => {
    if (!segment || !label) return;
    labels.set(segment, label);
    emit();
    return () => {
      labels.delete(segment);
      emit();
    };
  }, [segment, label]);
}

/** Called by the TopBar: the current names, re-read whenever one changes. */
export function useCrumbLabels(): ReadonlyMap<string, string> {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0
  );
  return labels;
}
