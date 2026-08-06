"use client";

import { useEffect } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";

export default function PanelError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[panel]", error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center px-6 text-center">
      <Icon icon="solar:danger-triangle-linear" width={32} className="text-danger" aria-hidden />
      <h1 className="text-foreground mt-3 text-base font-medium">Qualcosa è andato storto</h1>
      <p className="text-muted mt-1 max-w-md text-sm">
        {error.message || "Errore imprevisto durante il caricamento della pagina."}
      </p>
      {/* The digest is the only handle on the server-side stack trace, so it is
          worth surfacing rather than hiding. */}
      {error.digest && (
        <code className="text-muted mt-2 font-mono text-xs">digest: {error.digest}</code>
      )}
      <Button variant="secondary" size="sm" className="mt-5" onPress={reset}>
        Riprova
      </Button>
    </div>
  );
}
