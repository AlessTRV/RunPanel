"use client";

import { useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAccent } from "@/components/Providers";
import { ACCENT_PRESETS, ACCENT_SETTING_KEY, type AccentPreset } from "@/lib/themes";

/**
 * Theme preset picker.
 *
 * The current preset comes from context, seeded by the server in the root
 * layout — not read back out of the DOM, which would either need an effect or
 * risk a hydration mismatch. Selecting one flips `data-accent` immediately so
 * the page restyles as you click, then persists; a failed save rolls back
 * rather than leaving the UI showing a preset that was never stored.
 */
export function AccentPicker() {
  const { accent, setAccent } = useAccent();
  const [saving, setSaving] = useState<AccentPreset | null>(null);

  async function choose(preset: AccentPreset) {
    if (preset === accent) return;
    const previous = accent;

    setAccent(preset);
    setSaving(preset);

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences: { [ACCENT_SETTING_KEY]: preset } }),
      });
      if (!res.ok) throw new Error("save failed");
    } catch {
      setAccent(previous);
      toast.error("Impossibile salvare il tema");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Preset di tema"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
    >
      {ACCENT_PRESETS.map((preset) => {
        const active = accent === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={preset.description}
            disabled={saving !== null}
            onClick={() => choose(preset.id)}
            className={cn(
              "flex items-center gap-2.5 rounded-[var(--radius)] border px-3 py-2.5 text-left transition-colors",
              // The one control where the token and the widget are the same
              // thing: picking a preset restyles its own highlight as you click.
              active ? "selected border-transparent" : "border-border hover:bg-surface-hover",
              saving !== null && "opacity-60"
            )}
          >
            <span
              aria-hidden
              className="border-border size-5 shrink-0 rounded-full border"
              style={{ background: preset.swatch }}
            />
            <span className="text-foreground min-w-0 flex-1 truncate text-sm">{preset.label}</span>
            {active && (
              <Icon icon="solar:check-circle-linear" width={16} className="text-accent shrink-0" />
            )}
          </button>
        );
      })}
    </div>
  );
}
