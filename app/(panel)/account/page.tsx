"use client";

import { useEffect, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { Segmented } from "@/components/ui/Segmented";
import { FieldHint } from "@/components/ui/Hint";
import { AccentPicker } from "@/components/ui/AccentPicker";
import { SessionList } from "@/components/ui/SessionList";
import { RegistryList } from "@/components/ui/RegistryList";

/**
 * Password, devices, and the handful of preferences the panel has.
 *
 * The clearest "this doesn't belong" screen in the app: five raw HeroUI Cards
 * where everything else uses `Panel`, and copy that alternated languages card by
 * card — "Change Password" above "Dispositivi" above "Registry privati" above
 * "Preferences". Password and preferences stay open because they are why anyone
 * comes here; devices, registries and theme are read once and then not again.
 */
export default function AccountPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const [pollingInterval, setPollingInterval] = useState("5");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [prefsSaving, setPrefsSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (data.polling_interval) setPollingInterval(data.polling_interval);
        if (data.timezone) setTimezone(data.timezone);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  async function changePassword() {
    if (newPassword !== confirmPassword) {
      toast.error("Le due password non coincidono");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("La password deve avere almeno 8 caratteri");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast.error(d.error || "Cambio password non riuscito");
        return;
      }
      toast.success("Password cambiata");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      toast.error("Cambio password non riuscito");
    } finally {
      setLoading(false);
    }
  }

  async function savePrefs() {
    setPrefsSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences: { polling_interval: pollingInterval, timezone } }),
      });
      if (res.ok) toast.success("Preferenze salvate");
      else {
        const d = await res.json();
        toast.error(d.error || "Salvataggio non riuscito");
      }
    } catch {
      toast.error("Salvataggio non riuscito");
    } finally {
      setPrefsSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="Account" description="Password, dispositivi e preferenze" />

      <div className="max-w-xl space-y-4">
        <Panel className="space-y-4">
          <PanelHeader
            title="Cambia password"
            description="Le altre sessioni vengono chiuse, questa resta"
          />
          <TextField type="password" value={currentPassword} onChange={setCurrentPassword}>
            <Label>Password attuale</Label>
            <Input />
          </TextField>
          <TextField type="password" value={newPassword} onChange={setNewPassword}>
            <Label>Nuova password</Label>
            <Input />
          </TextField>
          <TextField type="password" value={confirmPassword} onChange={setConfirmPassword}>
            <Label>Conferma la nuova password</Label>
            <Input />
          </TextField>
          <div>
            <Button variant="primary" isPending={loading} onPress={changePassword}>
              Cambia password
            </Button>
          </div>
        </Panel>

        <Panel className="space-y-4">
          <PanelHeader title="Preferenze" description="Come si comporta il pannello" />

          <div>
            <span className="text-muted mb-2 block text-sm font-medium">Frequenza di refresh</span>
            <Segmented
              label="Frequenza di refresh"
              value={pollingInterval}
              onChange={setPollingInterval}
              options={[
                { value: "2", label: "2s" },
                { value: "5", label: "5s" },
                { value: "10", label: "10s" },
              ]}
            />
            <FieldHint>
              Ogni quanto le pagine ricaricano stato e metriche. Il polling si ferma comunque
              quando la scheda non è in primo piano.
            </FieldHint>
          </div>

          <TextField value={timezone} onChange={setTimezone}>
            <Label>Fuso orario</Label>
            <Input placeholder="Europe/Rome" />
          </TextField>

          <div>
            <Button variant="primary" isPending={prefsSaving} onPress={savePrefs}>
              Salva preferenze
            </Button>
          </div>
        </Panel>

        <Section title="Dispositivi" summary="Sessioni attive su questo account">
          <SessionList />
        </Section>

        <Section title="Registry privati" summary="Credenziali per pull e build di immagini private">
          <RegistryList />
        </Section>

        <Section title="Tema" summary="Solo il colore d'accento">
          <AccentPicker />
          <FieldHint>
            Gli stati — running, deploying, errore — restano identici in ogni preset: un tema non
            deve poter rendere indistinguibili due situazioni diverse.
          </FieldHint>
        </Section>
      </div>
    </>
  );
}
