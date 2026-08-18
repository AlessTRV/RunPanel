"use client";

import { useEffect, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { Segmented } from "@/components/ui/Segmented";
import { Code, FieldHint } from "@/components/ui/Hint";
import { AccentPicker } from "@/components/ui/AccentPicker";
import { SessionList } from "@/components/ui/SessionList";
import { RegistryList } from "@/components/ui/RegistryList";
import { NotificationSettings } from "@/components/ui/NotificationSettings";
import {
  DEFAULT_POLL_INTERVAL,
  isPollInterval,
  POLL_INTERVALS,
  type PollInterval,
} from "@/lib/polling";

/**
 * Password, devices, and the handful of preferences the panel has.
 *
 * The clearest "this doesn't belong" screen in the app: five raw HeroUI Cards
 * where everything else uses `Panel`, and copy that alternated languages card by
 * card — "Change Password" above "Dispositivi" above "Registry privati" above
 * "Preferences". Password and preferences stay open because they are why anyone
 * comes here; devices, registries and theme are read once and then not again.
 */
/**
 * Labels for the shared interval list.
 *
 * A `Record` over the union rather than a hand-written array of pairs: the list
 * lives in lib/polling.ts and is also what the settings schema validates
 * against, so adding an interval there now fails to compile here until it has a
 * label, instead of quietly rendering a picker the API would reject.
 */
const POLL_INTERVAL_LABELS: Record<PollInterval, string> = {
  "30": "30 s",
  "60": "1 min",
  "120": "2 min",
  "300": "5 min",
  "600": "10 min",
  "900": "15 min",
  "1800": "30 min",
};

const POLL_INTERVAL_OPTIONS = POLL_INTERVALS.map((value) => ({
  value,
  label: POLL_INTERVAL_LABELS[value],
}));

export default function AccountPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const [pollingInterval, setPollingInterval] = useState("5");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [publicUrl, setPublicUrl] = useState("");
  // Seeded from the shared default, not from "5": that is a value belonging to
  // the refresh picker above, and it is not one of this control's options — so
  // until the setting had been saved once, a "pick one" that disallows an empty
  // selection rendered with nothing picked at all.
  const [pollInterval, setPollInterval] = useState<PollInterval>(DEFAULT_POLL_INTERVAL);
  const [prefsSaving, setPrefsSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (data.polling_interval) setPollingInterval(data.polling_interval);
        if (data.timezone) setTimezone(data.timezone);
        if (data.panel_public_url) setPublicUrl(data.panel_public_url);
        // Narrowed rather than trusted: this arrives as JSON, and a stored
        // value that is not on the list is the same empty-picker bug the
        // default above was fixing, just arriving from the other direction.
        if (isPollInterval(data.deploy_poll_interval)) {
          setPollInterval(data.deploy_poll_interval);
        }
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
        body: JSON.stringify({
          preferences: {
            polling_interval: pollingInterval,
            timezone,
            panel_public_url: publicUrl.trim(),
            deploy_poll_interval: pollInterval,
          },
        }),
      });
      if (res.ok) toast.success("Preferenze salvate");
      else {
        const d = await res.json();
        // The public URL is the one preference that can be rejected for a
        // reason worth reading — a private address GitHub could never reach.
        toast.error(d.details?.[0]?.message || d.error || "Salvataggio non riuscito");
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

          {/*
            The one address the panel cannot work out for itself.

            Everywhere else an absolute URL is built in the browser from the page
            it is on, which is right for a link someone clicks. The webhook is
            the exception: GitHub has to reach it from outside, and behind a
            reverse proxy or a tunnel the name this machine knows itself by is
            not the name that resolves from the internet.
          */}
          <div>
            <TextField value={publicUrl} onChange={setPublicUrl}>
              <Label>Indirizzo pubblico</Label>
              <Input placeholder="https://panel.esempio.it" className="font-mono text-sm" />
            </TextField>
            <FieldHint>
              Da qui il pannello ricava l&apos;URL dei webhook GitHub. Lascialo vuoto per dedurlo
              dalla richiesta: va bene finché lo apri dallo stesso indirizzo da cui lo raggiunge
              GitHub. Se il pannello non è raggiungibile da internet, usa il controllo periodico
              nelle impostazioni del progetto.
            </FieldHint>
          </div>

          <div>
            <span className="text-muted mb-2 block text-sm font-medium">
              Controllo periodico dei repository
            </span>
            <Segmented
              label="Controllo periodico dei repository"
              value={pollInterval}
              onChange={setPollInterval}
              options={POLL_INTERVAL_OPTIONS}
            />
            <FieldHint>
              Ogni quanto RunPanel guarda il branch dei progetti impostati su{" "}
              <strong className="text-foreground">Controllo periodico</strong>. Un branch fermo
              risponde <Code>304 Not Modified</Code>, che GitHub non conta nel limite di richieste:
              anche 30 secondi costano poco.
            </FieldHint>
          </div>

          <div>
            <Button variant="primary" isPending={prefsSaving} onPress={savePrefs}>
              Salva preferenze
            </Button>
          </div>
        </Panel>

        <Section title="Dispositivi" summary="Sessioni attive su questo account">
          <SessionList />
        </Section>

        <Section
          title="Notifiche Telegram"
          summary="Crash, esiti dei deploy, backup e aggiornamenti, su un bot"
        >
          <NotificationSettings />
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
