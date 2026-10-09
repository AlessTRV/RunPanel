"use client";

import { useRef, useState } from "react";
import { Button, Modal } from "@heroui/react";
import { toast } from "sonner";
import { MSG } from "@/lib/copy";

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
  /** Return `false` to keep the dialog, and what was typed, after a failure. */
  onSubmit: () => void | boolean | Promise<void | boolean>;
  children: React.ReactNode;
}) {
  // A ref rather than state: the body owns `pending`, and the backdrop only
  // needs to read it at the moment it is asked to close.
  const busyRef = useRef(false);

  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => {
        // Esc and backdrop must not close a dialog whose submit is running.
        if (!open && busyRef.current) return;
        onOpenChange(open);
      }}
    >
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
            busyRef={busyRef}
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
  busyRef,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  submitLabel: string;
  cancelLabel: string;
  isSubmitDisabled: boolean;
  destructive: boolean;
  /** Return `false` to keep the dialog, and what was typed, after a failure. */
  onSubmit: () => void | boolean | Promise<void | boolean>;
  onOpenChange: (open: boolean) => void;
  busyRef: React.RefObject<boolean>;
  children: React.ReactNode;
}) {
  const [pending, setPending] = useState(false);

  async function handleSubmit() {
    setPending(true);
    busyRef.current = true;
    try {
      // `false` means the submit failed and said so itself: keep the input.
      if ((await onSubmit()) === false) return;
      onOpenChange(false);
    } catch (err) {
      // Callers that already reported their failure throw to stay open; only a
      // fetch that never reached the panel (a TypeError) is left to say here.
      if (err instanceof TypeError) toast.error(MSG.unreachable);
    } finally {
      busyRef.current = false;
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
