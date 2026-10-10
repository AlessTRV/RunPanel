"use client";

import { useEffect, useRef } from "react";

/**
 * One save for the whole settings tab.
 *
 * The tab had four ways of saving: the sticky bar for the main fields, and a
 * button at the bottom of each of three sections. Changing the branch and a
 * backup exclusion, then pressing the bar, saved the branch and silently left
 * the exclusion behind. Sections with unsaved edits now register here, the bar
 * lists them and saves them all.
 *
 * Each section keeps its own endpoint and its own payload, unchanged: this only
 * decides when its `save` runs. A section that is not dirty is not registered,
 * so it is never sent and can never overwrite what is stored.
 *
 * Mounts are deliberately not part of it: applying them stops and restarts the
 * app, which is an action, not a setting being saved.
 */
export interface PendingSave {
  /** Named in the bar and in the error toast. */
  label: string;
  /** Resolves false when it did not save; the section shows why. */
  save: () => Promise<boolean>;
  reset: () => void;
}

export type RegisterPendingSave = (id: string, entry: PendingSave | null) => void;

/**
 * Registers a section while it is dirty. The callbacks are read through refs,
 * so the registration changes only when `dirty` does — re-registering on every
 * render would re-render the tab on every keystroke, and loop.
 */
export function usePendingSave(
  register: RegisterPendingSave | undefined,
  id: string,
  label: string,
  dirty: boolean,
  save: () => Promise<boolean>,
  reset: () => void
): void {
  const saveRef = useRef(save);
  const resetRef = useRef(reset);
  useEffect(() => {
    saveRef.current = save;
    resetRef.current = reset;
  });

  useEffect(() => {
    if (!register) return;
    register(
      id,
      dirty ? { label, save: () => saveRef.current(), reset: () => resetRef.current() } : null
    );
    return () => register(id, null);
  }, [register, id, label, dirty]);
}
