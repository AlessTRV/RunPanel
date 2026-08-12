"use client";

import { useState } from "react";
import { AlertDialog, Button } from "@heroui/react";

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
  onConfirm: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  async function handleConfirm() {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
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
              <p className="text-muted text-sm">{description}</p>
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

/**
 * Small state helper so a page can drive several confirmations without keeping
 * a boolean and a payload per action.
 */
export function useConfirm<T>() {
  const [target, setTarget] = useState<T | null>(null);
  return {
    target,
    isOpen: target !== null,
    ask: (value: T) => setTarget(value),
    close: () => setTarget(null),
    onOpenChange: (open: boolean) => {
      if (!open) setTarget(null);
    },
  };
}
