"use client";

import { useState } from "react";
import { AlertDialog, Button } from "@heroui/react";
import { toast } from "sonner";
import { MSG } from "@/lib/copy";

/**
 * Confirmation for destructive actions.
 *
 * Replaces six `window.confirm()` calls and two hand-rolled modals that had no
 * focus trap, no `role="dialog"` and no scroll lock. Built on HeroUI's
 * AlertDialog so focus management and Escape handling come from the library
 * rather than from a `window.addEventListener("keydown")` in a page component.
 *
 * `onConfirm` may be async: the dialog stays open with the button in a pending
 * state until it settles, so a slow delete cannot be fired twice.
 */
export function ConfirmDialog({
  isOpen,
  onOpenChange,
  title,
  description,
  confirmLabel = "Conferma",
  cancelLabel = "Annulla",
  destructive = false,
  onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Return `false` to keep the dialog open after a failure it already reported. */
  onConfirm: () => void | boolean | Promise<void | boolean>;
}) {
  const [pending, setPending] = useState(false);

  async function handleConfirm() {
    setPending(true);
    try {
      // `false` means the action failed and said so itself: stay open.
      if ((await onConfirm()) === false) return;
      onOpenChange(false);
    } catch (err) {
      // Callers that already reported their failure throw to stay open; only a
      // fetch that never reached the panel (a TypeError) is left to say here.
      if (err instanceof TypeError) toast.error(MSG.unreachable);
    } finally {
      setPending(false);
    }
  }

  // No AlertDialog.Root: that is react-aria's DialogTrigger, which wraps its
  // children in a PressResponder to turn the first one into the trigger. This
  // dialog has no trigger element — it is opened from state — so nothing ever
  // registered as pressable and every mount logged "A PressResponder was
  // rendered without a pressable child". The backdrop is a ModalOverlay, which
  // takes isOpen/onOpenChange directly when it is not inside a trigger.
  return (
    <AlertDialog.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => {
        // Never let a backdrop click cancel work that is already running.
        if (pending) return;
        onOpenChange(open);
      }}
    >
      <AlertDialog.Container>
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Heading>{title}</AlertDialog.Heading>
          </AlertDialog.Header>
          {description && (
            <AlertDialog.Body>
              {/* A div, not a p: callers put labels and controls in here. */}
              <div className="text-muted text-sm">{description}</div>
            </AlertDialog.Body>
          )}
          <AlertDialog.Footer className="justify-end gap-2">
            <Button variant="ghost" isDisabled={pending} onPress={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button
              variant={destructive ? "danger" : "primary"}
              isPending={pending}
              onPress={handleConfirm}
            >
              {confirmLabel}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

