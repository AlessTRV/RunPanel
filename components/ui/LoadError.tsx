"use client";

import { Button } from "@heroui/react";
import { Hint } from "./Hint";

/**
 * What a section shows when its data did not load.
 *
 * Without it a failed fetch looked like an empty list or a clean verdict, and
 * an editor seeded from "nothing" could save that nothing over the real data.
 * A section that failed to load renders this instead of its content.
 */
export function LoadError({
  error,
  onRetry,
  what = "i dati",
  className,
}: {
  error: string;
  onRetry?: () => void;
  /** What failed to load, as it reads after "Impossibile caricare". */
  what?: string;
  className?: string;
}) {
  return (
    <div role="alert" className={className}>
      <Hint tone="warn" title={`Impossibile caricare ${what}`}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="break-words">{error}</span>
          {onRetry && (
            <Button size="sm" variant="secondary" onPress={onRetry}>
              Riprova
            </Button>
          )}
        </div>
      </Hint>
    </div>
  );
}
