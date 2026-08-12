"use client";

import { useState } from "react";
import { Button, Modal } from "@heroui/react";

/**
 * The dialog that asks for something, rather than asking whether.
 *
 * `ConfirmDialog` exists and is used correctly in six files — but it is yes/no
 * only, so anything with a field in it had to be built by hand. Two were: the
 * restore dialog, which at least reached for HeroUI's AlertDialog directly, and
 * the project rename overlay, which is a raw `fixed inset-0` div with a manual
 * backdrop click handler — no `role="dialog"`, no `aria-modal`, no focus trap,
 * no Escape. It sits fifteen lines above a correctly-used `ConfirmDialog`, and
 * `ConfirmDialog`'s own docstring says it was written to replace exactly that
 * kind of overlay. It came back because nothing covered this case.
 *
 * Same Backdrop-without-Root trick as `ConfirmDialog`, and for the same reason:
 * `Modal.Root` is react-aria's DialogTrigger, which turns its first child into
 * a trigger. These dialogs are opened from state and have no trigger element,
 * so it would warn on every mount.
 *
 * `onSubmit` may be async and the dialog stays open, pending, until it settles
 * — so a slow save cannot be submitted twice and a failure leaves the user's
 * input on screen instead of discarding it.
 */
export function FormDialog({
  isOpen,
  onOpenChange,
  title,
  description,
  submitLabel = "Salva",
  cancelLabel = "Annulla",
  isSubmitDisabled = false,
  destructive = false,
  wide = false,
  onSubmit,
  children,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  submitLabel?: string;
  cancelLabel?: string;
  isSubmitDisabled?: boolean;
  destructive?: boolean;
  /** For a dialog that holds a list or a table rather than a couple of fields. */
  wide?: boolean;
  onSubmit: () => void | Promise<void>;
  children: React.ReactNode;
}) {
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container>
        <Modal.Dialog className={wide ? "max-w-2xl" : undefined}>
          <DialogBody
            title={title}
            description={description}
            submitLabel={submitLabel}
            cancelLabel={cancelLabel}
            isSubmitDisabled={isSubmitDisabled}
            destructive={destructive}
            onSubmit={onSubmit}
            onOpenChange={onOpenChange}
          >
            {children}
          </DialogBody>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/**
 * Split out so the pending state is created when the dialog opens and destroyed
 * when it closes. Kept in the parent it would survive across openings, and a
 * dialog reopened after a failed submit would come back still pending.
 */
function DialogBody({
  title,
  description,
  submitLabel,
  cancelLabel,
  isSubmitDisabled,
  destructive,
  onSubmit,
  onOpenChange,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  submitLabel: string;
  cancelLabel: string;
  isSubmitDisabled: boolean;
  destructive: boolean;
  onSubmit: () => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [pending, setPending] = useState(false);

  async function handleSubmit() {
    setPending(true);
    try {
      await onSubmit();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Modal.Header>
        <Modal.Heading>{title}</Modal.Heading>
      </Modal.Header>
      <Modal.Body className="space-y-4">
        {description && <p className="text-muted text-sm">{description}</p>}
        {children}
      </Modal.Body>
      <Modal.Footer className="justify-end gap-2">
        <Button variant="ghost" isDisabled={pending} onPress={() => onOpenChange(false)}>
          {cancelLabel}
        </Button>
        <Button
          variant={destructive ? "danger" : "primary"}
          isPending={pending}
          isDisabled={isSubmitDisabled}
          onPress={handleSubmit}
        >
          {submitLabel}
        </Button>
      </Modal.Footer>
    </>
  );
}
