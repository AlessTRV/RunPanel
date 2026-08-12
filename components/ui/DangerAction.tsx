"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { Panel } from "./Panel";

/**
 * One treatment for "this destroys something", in the two shapes it takes.
 *
 * There were three, and the differences were not decorative. A solid `danger`
 * button in five places, all confirmed. A ghost icon with the trash glyph tinted
 * `text-danger` in three — one of which, the registry list, fired its DELETE on
 * the first click with no confirmation at all: the only such flow in the panel.
 * And a ghost icon with no tint whatsoever in the backups list, which at a
 * glance is indistinguishable from a neutral action.
 *
 * So the same glyph meant "safe", "careful" and "gone forever" depending on the
 * screen. Routing every one through here means a delete cannot be shipped
 * without a confirmation, because there is no longer a way to write one.
 *
 * The rule the two shapes encode: solid `danger` is reserved for the confirming
 * button inside a dialog and for a page-level danger zone. Never in a list row —
 * a row of red buttons stops meaning anything.
 *
 * What does NOT belong here: removing a row from a form that has not been saved
 * yet. The env editor drops a variable from local state and nothing happens
 * until "Salva" — asking twice for something a Cancel already undoes trains
 * people to dismiss confirmations without reading them, which is what makes the
 * real ones stop working. The line is whether the click reaches the server.
 */

interface Confirmation {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
}

/**
 * The irreversible action at the bottom of a page, boxed and explained.
 *
 * The description belongs in the dialog, not here: what is about to be lost is
 * worth reading at the moment of deciding, not while scrolling past on the way
 * to something else.
 */
export function DangerZone({
  title,
  description,
  actionLabel,
  confirm,
  onConfirm,
  isDisabled = false,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  actionLabel: string;
  confirm: Confirmation;
  onConfirm: () => void | Promise<void>;
  isDisabled?: boolean;
  /** Extra controls that qualify the action — "also delete the volume". */
  children?: React.ReactNode;
}) {
  const [asking, setAsking] = useState(false);

  return (
    <Panel className="border-danger/30 space-y-3">
      <div className="min-w-0">
        <h2 className="text-foreground text-sm font-medium">{title}</h2>
        {description && <p className="text-muted mt-0.5 text-xs">{description}</p>}
      </div>

      {children}

      <Button variant="danger" size="sm" isDisabled={isDisabled} onPress={() => setAsking(true)}>
        {actionLabel}
      </Button>

      <ConfirmDialog
        isOpen={asking}
        onOpenChange={setAsking}
        title={confirm.title}
        description={confirm.description}
        confirmLabel={confirm.confirmLabel ?? actionLabel}
        destructive
        onConfirm={onConfirm}
      />
    </Panel>
  );
}

/**
 * The delete that lives in a row. Always ghost, always tinted, always confirmed
 * — the three properties that were each missing somewhere.
 */
export function DeleteButton({
  label,
  confirm,
  onConfirm,
  isDisabled = false,
  icon = "solar:trash-bin-trash-linear",
  className,
}: {
  /** Accessible name — the button shows only an icon. */
  label: string;
  confirm: Confirmation;
  onConfirm: () => void | Promise<void>;
  isDisabled?: boolean;
  icon?: string;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label={label}
        isDisabled={isDisabled}
        onPress={() => setAsking(true)}
        className={cn("text-danger", className)}
      >
        <Icon icon={icon} width={16} aria-hidden />
      </Button>

      <ConfirmDialog
        isOpen={asking}
        onOpenChange={setAsking}
        title={confirm.title}
        description={confirm.description}
        confirmLabel={confirm.confirmLabel ?? "Elimina"}
        destructive
        onConfirm={onConfirm}
      />
    </>
  );
}
