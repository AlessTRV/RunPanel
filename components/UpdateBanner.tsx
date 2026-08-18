"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LinkButton } from "@/components/ui/LinkButton";
import { usePanelUpdate } from "@/lib/hooks/usePanelUpdate";
import { MSG } from "@/lib/copy";
import { hasUpdate, isUpdateActive } from "@/lib/panel-update";

/**
 * "There is a new version", on every screen.
 *
 * Below the TopBar and in normal flow, not above it and not fixed. The mobile
 * menu button is `fixed top-3 right-3 z-50` and the TopBar carries a `pr-14`
 * below `md` to clear it — a strip placed above the bar would slide underneath
 * that button on every phone.
 *
 * The button starts the update rather than merely linking to the page, because
 * that is what a notification with a button on it promises. It still confirms
 * first, and it still lands you on `/updates`: the panel is about to restart
 * under you, and the log is the only thing that makes that legible.
 *
 * Dismissal is keyed by the SHA being offered and kept in `localStorage`.
 * Closing a banner is something a person does to their browser, not a setting
 * the panel holds about itself — and keying it by target means the *next*
 * update comes back rather than being silenced forever.
 */

const DISMISS_KEY = "runpanel:update-dismissed";

function readDismissed(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    // Private mode, or storage disabled. The banner then simply never hides,
    // which is the right way round for a notice about an unapplied update.
    return null;
  }
}

export function UpdateBanner() {
  const pathname = usePathname();
  const router = useRouter();
  const { status: data, refresh } = usePanelUpdate();
  // Read once, in the initialiser rather than in an effect. There is no
  // hydration risk: nothing renders until the fetch lands, which is client-only.
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [confirming, setConfirming] = useState(false);

  // The page says all of this, in more detail, while you are looking at it.
  if (pathname.startsWith("/updates")) return null;
  if (!data) return null;

  const active = isUpdateActive(data);
  const available = hasUpdate(data);
  const target = data.check?.remoteSha ?? null;

  if (!active && (!available || (target && dismissed === target))) return null;

  function dismiss() {
    if (!target) return;
    try {
      window.localStorage.setItem(DISMISS_KEY, target);
    } catch {
      /* see above */
    }
    setDismissed(target);
  }

  async function apply() {
    try {
      const res = await fetch("/api/updates/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedSha: target }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };

      if (!res.ok) {
        toast.error(body.error ?? MSG.updateFailed);
        refresh();
        return;
      }

      // Straight to the log. From here on the interesting thing is the output,
      // and shortly after that the panel stops answering at all.
      router.push("/updates");
    } catch {
      toast.error(MSG.unreachable);
    }
  }

  return (
    <>
      <div
        role="status"
        className="border-border bg-surface-secondary/60 flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5 text-sm sm:px-6 lg:px-8"
      >
        <Icon
          icon={active ? "solar:refresh-circle-bold-duotone" : "solar:refresh-circle-linear"}
          width={17}
          aria-hidden
          className="text-accent shrink-0"
        />

        {active ? (
          <span className="text-foreground min-w-0 flex-1">
            Aggiornamento del pannello in corso
            {data.run?.step ? <span className="text-muted"> — {data.run.step}</span> : null}
          </span>
        ) : (
          <span className="text-foreground min-w-0 flex-1">
            Aggiornamento disponibile
            <span className="text-muted">
              {" — "}
              {data.check?.behind === 1 ? "1 commit" : `${data.check?.behind} commit`}
            </span>
            {data.checkout.short && target && (
              <span className="text-muted ml-2 font-mono text-xs">
                {data.checkout.short} → {target.slice(0, 7)}
              </span>
            )}
          </span>
        )}

        <div className="flex shrink-0 items-center gap-2">
          <LinkButton href="/updates">{active ? "Segui" : "Dettagli"}</LinkButton>
          {!active && (
            <>
              <Button size="sm" variant="primary" onPress={() => setConfirming(true)}>
                Aggiorna
              </Button>
              <Button size="sm" variant="ghost" onPress={dismiss} aria-label="Nascondi l'avviso">
                <Icon icon="solar:close-circle-linear" width={16} aria-hidden />
              </Button>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title="Aggiornare RunPanel?"
        confirmLabel="Aggiorna e riavvia"
        description={
          <>
            Il pannello scarica la nuova versione, installa, builda e si riavvia. Le modifiche
            locali non committate in questa installazione vengono scartate. I progetti e i servizi
            in esecuzione non vengono toccati.
          </>
        }
        onConfirm={apply}
      />
    </>
  );
}
