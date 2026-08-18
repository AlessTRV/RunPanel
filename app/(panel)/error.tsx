"use client";

import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";

/**
 * Whether this error is the page asking for a file the server no longer has.
 *
 * A Next build names every chunk after a hash of its contents, and the HTML a
 * tab loaded refers to them by name. Rebuild the panel and those names change:
 * a tab that has been open across the rebuild is holding a map to a build that
 * no longer exists, and the first navigation that needs a chunk it has not
 * already fetched fails with this.
 *
 * It became routine the moment the panel learned to update itself — every
 * update is a rebuild, and the tab you pressed the button in is not the only
 * one open. The page is not broken; it is stale, and the fix is to fetch the
 * new one.
 */
function isStaleBundle(error: Error): boolean {
  return (
    error.name === "ChunkLoadError" ||
    /Loading chunk [^ ]+ failed/i.test(error.message) ||
    /Failed to fetch dynamically imported module/i.test(error.message) ||
    /Loading CSS chunk/i.test(error.message)
  );
}

/**
 * Reload once, and only once.
 *
 * The guard is the whole point: if the reload does not fix it — a build that is
 * genuinely missing files, a proxy serving a stale index — then reloading again
 * produces the same error, and a page that reloads itself forever is worse than
 * one that shows a message. So the attempt is recorded in `sessionStorage`, and
 * the second time round the operator gets the message and the button.
 */
const RELOAD_KEY = "runpanel:chunk-reload";

export default function PanelError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  /*
    Decided once, during the first render, and recorded in the same breath.

    A lazy initialiser rather than an effect that sets state: claiming the one
    allowed attempt and deciding what to draw are the same decision, and split
    across a render and an effect they can disagree for a frame — which here
    means flashing an error the page is about to reload away from.
  */
  const [reloading] = useState(() => {
    if (typeof window === "undefined" || !isStaleBundle(error)) return false;
    try {
      if (window.sessionStorage.getItem(RELOAD_KEY) === "1") return false;
      window.sessionStorage.setItem(RELOAD_KEY, "1");
      return true;
    } catch {
      // Storage disabled. Without somewhere to record the attempt there is no
      // way to stop a loop, so do not start one.
      return false;
    }
  });

  useEffect(() => {
    console.error("[panel]", error);
  }, [error]);

  useEffect(() => {
    if (!reloading) return;
    // `location.reload()` and not `reset()`: the stale map is in the document,
    // so re-rendering the same document would ask for the same missing chunk.
    window.location.reload();
  }, [reloading]);

  // An error that is not a stale bundle means the page is being served fine, so
  // the next update gets its own single attempt rather than inheriting this one.
  useEffect(() => {
    if (isStaleBundle(error)) return;
    try {
      window.sessionStorage.removeItem(RELOAD_KEY);
    } catch {
      /* nothing to clear */
    }
  }, [error]);

  const stale = isStaleBundle(error);

  if (reloading) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center px-6 text-center">
        <Icon
          icon="solar:refresh-circle-linear"
          width={32}
          className="text-accent"
          aria-hidden
        />
        <h1 className="text-foreground mt-3 text-base font-medium">Ricarico la pagina</h1>
        <p className="text-muted mt-1 max-w-md text-sm">
          Il pannello è stato ricostruito da quando hai aperto questa scheda, quindi stava
          chiedendo file di una versione che non c&apos;è più.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center px-6 text-center">
      <Icon icon="solar:danger-triangle-linear" width={32} className="text-danger" aria-hidden />
      <h1 className="text-foreground mt-3 text-base font-medium">Qualcosa è andato storto</h1>
      <p className="text-muted mt-1 max-w-md text-sm">
        {stale
          ? "La pagina appartiene a una versione del pannello che non c'è più, e ricaricarla non è bastato. Prova a svuotare la cache di questa scheda."
          : "La pagina non è riuscita a caricarsi. Riprova; se continua, il dettaglio qui sotto è quello che serve per capire perché."}
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
      <Button
        variant="secondary"
        size="sm"
        className="mt-5"
        onPress={() => (stale ? window.location.reload() : reset())}
      >
        {stale ? "Ricarica" : "Riprova"}
      </Button>
    </div>
  );
}
