"use client";

import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { toast } from "sonner";
import { Field } from "@/components/ui/Field";
import { FieldHint } from "@/components/ui/Hint";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { MSG } from "@/lib/copy";
import {
  PANEL_UPDATE_ALLOWED_SIGNERS_SETTING,
  PANEL_UPDATE_REQUIRE_SIGNATURE_SETTING,
} from "@/lib/panel-update";

/**
 * Whether an update has to be signed before it is installed.
 *
 * Off by default, and the copy has to earn the switch rather than assume it:
 * turning this on when the repository's commits are not signed makes the update
 * button stop working, which is a worse outcome than the risk it removes for
 * most people. So the description says what it costs, and the failure at update
 * time says exactly what to configure.
 */
export function SignatureSettings() {
  const [required, setRequired] = useState(false);
  const [signers, setSigners] = useState("");
  const [savedSigners, setSavedSigners] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) return;
        // The endpoint returns the allowlisted settings as a flat object, not
        // wrapped: absent keys simply are not there.
        const body = (await res.json()) as Record<string, string | undefined>;
        if (!alive) return;
        const value = body[PANEL_UPDATE_ALLOWED_SIGNERS_SETTING] ?? "";
        setRequired(body[PANEL_UPDATE_REQUIRE_SIGNATURE_SETTING] === "1");
        setSigners(value);
        setSavedSigners(value);
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function saveRequired(next: boolean) {
    setRequired(next);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferences: { [PANEL_UPDATE_REQUIRE_SIGNATURE_SETTING]: next ? "1" : "0" },
        }),
      });
      if (res.ok) toast.success(next ? "Verifica della firma attiva" : "Verifica della firma disattivata");
      else {
        setRequired(!next);
        toast.error(MSG.saveFailed);
      }
    } catch {
      setRequired(!next);
      toast.error(MSG.unreachable);
    }
  }

  async function saveSigners() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [PANEL_UPDATE_ALLOWED_SIGNERS_SETTING]: signers }),
      });
      if (res.ok) {
        setSavedSigners(signers.trim());
        setSigners(signers.trim());
        toast.success("Firmatari ammessi salvati");
      } else toast.error(MSG.saveFailed);
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  return (
    <div className="space-y-4">
      <SettingToggle
        label="Pretendi un commit firmato"
        description={
          "Prima di applicare un aggiornamento il pannello esegue git verify-commit sul commit in arrivo. " +
          "Se non firmi già i tuoi commit, attivarla ferma il pulsante Aggiorna finché non configuri una firma."
        }
        isSelected={required}
        onChange={saveRequired}
      />

      {required && (
        <Field
          label="Firmatari ammessi (SSH)"
          htmlFor="allowed-signers"
          hint="Lasciando il campo vuoto la verifica usa GPG e il portachiavi dell'utente che esegue il pannello."
          explain={
            "Il formato è quello del file allowed_signers di OpenSSH: una riga per chiave, " +
            "email seguita dalla chiave pubblica. Il pannello lo scrive su disco a 0600 e lo passa a git " +
            "solo per il comando di verifica."
          }
        >
          <textarea
            id="allowed-signers"
            value={signers}
            onChange={(e) => setSigners(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder="tu@esempio.it ssh-ed25519 AAAAC3Nza..."
            className="border-border bg-background text-foreground focus:border-accent/60 w-full resize-y rounded-[var(--radius)] border px-3 py-2 font-mono text-sm outline-none"
          />
        </Field>
      )}

      {required && signers.trim() !== savedSigners && (
        <Button size="sm" onPress={saveSigners} isDisabled={saving}>
          {saving ? "Salvataggio…" : "Salva firmatari"}
        </Button>
      )}

      <FieldHint>
        Il trasporto è controllato sempre, indipendentemente da questa impostazione: un remote su{" "}
        <code>http://</code>, <code>git://</code> o <code>file://</code> viene rifiutato prima del
        fetch, perché da lì chiunque sia sul percorso di rete sceglierebbe che cosa viene eseguito
        su questa macchina.
      </FieldHint>
    </div>
  );
}
