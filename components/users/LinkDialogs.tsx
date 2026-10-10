"use client";

import { useState } from "react";
import { Input, Label, TextField } from "@heroui/react";
import { FormDialog } from "@/components/ui/FormDialog";
import { CopyField } from "@/components/ui/CopyField";
import { Segmented } from "@/components/ui/Segmented";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { formatWhen } from "@/lib/format";
import { LINK_DURATIONS } from "./labels";

type Duration = (typeof LINK_DURATIONS)[number]["value"];

/** The lifetime picker: three common choices, or any number of hours or days up to 30 days. */
export function DurationPicker({ onHours }: { onHours: (hours: number | null) => void }) {
  const [choice, setChoice] = useState<Duration>("24");
  const [amount, setAmount] = useState("3");
  const [unit, setUnit] = useState<"hours" | "days">("days");

  const emit = (c: Duration, a: string, u: "hours" | "days") => {
    if (c !== "custom") return onHours(Number(c));
    const n = Number.parseInt(a, 10);
    const hours = Number.isFinite(n) && n > 0 ? (u === "days" ? n * 24 : n) : null;
    onHours(hours !== null && hours <= 720 ? hours : null);
  };

  return (
    <div className="space-y-2">
      <span className="text-muted block text-sm font-medium">Validità del link</span>
      <Segmented
        label="Validità del link"
        value={choice}
        onChange={(c) => {
          setChoice(c);
          emit(c, amount, unit);
        }}
        options={LINK_DURATIONS}
      />
      {choice === "custom" && (
        <div className="flex items-end gap-2">
          <TextField
            value={amount}
            onChange={(v) => {
              setAmount(v);
              emit(choice, v, unit);
            }}
            className="w-24"
          >
            <Label>Durata</Label>
            <Input inputMode="numeric" />
          </TextField>
          <Segmented
            label="Unità"
            value={unit}
            onChange={(u) => {
              setUnit(u);
              emit(choice, amount, u);
            }}
            options={[
              { value: "hours", label: "ore" },
              { value: "days", label: "giorni" },
            ]}
          />
        </div>
      )}
      <FieldHint>Da 1 ora a 30 giorni. Il link funziona una volta sola.</FieldHint>
    </div>
  );
}

/** Shows a freshly issued link once — it is not stored and cannot be shown again. */
export function LinkResultDialog({
  link,
  onClose,
}: {
  link: { url: string; expiresAt: string; kind: "invite" | "reset" } | null;
  onClose: () => void;
}) {
  return (
    <FormDialog
      isOpen={link !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={link?.kind === "reset" ? "Link per la nuova password" : "Link di invito"}
      description="Mandalo tu alla persona, nel modo che preferisci: il pannello non invia email."
      submitLabel="Fatto"
      onSubmit={() => onClose()}
    >
      {link && (
        <div className="space-y-3">
          <CopyField value={link.url} label="Link" />
          <Hint tone="warn">
            Lo vedi solo ora. Scade {formatWhen(link.expiresAt)}; generarne un altro invalida questo.
          </Hint>
        </div>
      )}
    </FormDialog>
  );
}
