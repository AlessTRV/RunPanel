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
        La pagina non è riuscita a caricarsi. Riprova; se continua, il dettaglio qui sotto è
        quello che serve per capire perché.
      </p>

      {/*
        The raw message under its own heading, in mono.

        It used to sit directly under the Italian sentence in the same style, so
        an English stack-trace fragment read as something the panel was saying.
        Presenting it as machine output is the difference between "RunPanel is
        speaking gibberish" and "here is what the runtime reported".
      */}
      {error.message && (
        <div className="mt-4 w-full max-w-md text-left">
          <p className="text-muted text-meta mb-1">Dettaglio tecnico</p>
          <pre className="border-border bg-background text-muted overflow-auto rounded-[var(--radius)] border p-3 font-mono text-xs break-words whitespace-pre-wrap">
            {error.message}
          </pre>
        </div>
      )}
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
