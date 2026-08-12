"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy to the clipboard, with the "Copied" state that always follows it.
 *
 * Written twice before this: once inside `CopyField`, once inside the autostart
 * page's command block — same `navigator.clipboard.writeText` in a try/catch,
 * same 1.5s flag, two timers nobody cleared. A component that unmounted while
 * the flag was still set left a `setState` scheduled on a gone component.
 *
 * The clipboard API rejects on an insecure origin and when the document is not
 * focused, and neither is worth an error to the user: the value is selectable
 * either way, so a failure just leaves `copied` false.
 */
export function useClipboard(resetAfterMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        return false;
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), resetAfterMs);
      return true;
    },
    [resetAfterMs]
  );

  return { copied, copy };
}
