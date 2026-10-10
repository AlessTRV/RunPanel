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
import { LoadError } from "@/components/ui/LoadError";
import { RegistryList } from "@/components/ui/RegistryList";
import { NotificationSettings } from "@/components/ui/NotificationSettings";
import { useCan, useMe } from "@/lib/hooks/useMe";
import {
  DEFAULT_POLL_INTERVAL,
  isPollInterval,
  POLL_INTERVALS,
  type PollInterval,
} from "@/lib/polling";

/**
 * What the panel does for everyone, as opposed to Account, which is yours.
 *
 * These used to share one page, so changing your password meant scrolling past
 * the timezone every schedule runs in. The owner sees all of it; anyone else
 * only the integrations they are allowed to manage.
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

export default function PanelSettingsPage() {
  const me = useMe();
  const canNotify = useCan("notifications");
  const canRegistries = useCan("registries");

  const [pollingInterval, setPollingInterval] = useState("5");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  /**
   * The zone the schedulers really use, as the server reports it. The field
   * above is prefilled with the browser's zone for convenience, which made an
   * unsaved panel look configured while every schedule ran in UTC.
   */
  const [effectiveZone, setEffectiveZone] = useState<string | null>(null);
  const [zoneSaved, setZoneSaved] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  // Seeded from the shared default, not from "5": that is a value belonging to
  // the refresh picker above, and it is not one of this control's options — so
  // until the setting had been saved once, a "pick one" that disallows an empty
  // selection rendered with nothing picked at all.
  const [pollInterval, setPollInterval] = useState<PollInterval>(DEFAULT_POLL_INTERVAL);
  const [prefsSaving, setPrefsSaving] = useState(false);
  // "Salva preferenze" sends every field, so it stays off until the stored
  // values have arrived: saving the defaults would wipe the public URL and
  // move the schedulers' zone.
  const [prefsLoad, setPrefsLoad] = useState<"loading" | "ready" | string>("loading");
  const [prefsAttempt, setPrefsAttempt] = useState(0);

  useEffect(() => {
    // Panel-wide preferences are the owner's; nobody else is shown the form.
    if (!me.isOwner) return;
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Il server ha risposto ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (data.polling_interval) setPollingInterval(data.polling_interval);
        if (data.timezone) setTimezone(data.timezone);
        setZoneSaved(Boolean(data.timezone));
        if (typeof data.timezone_effective === "string") setEffectiveZone(data.timezone_effective);
        if (data.panel_public_url) setPublicUrl(data.panel_public_url);
        // Narrowed rather than trusted: this arrives as JSON, and a stored
        // value that is not on the list is the same empty-picker bug the
        // default above was fixing, just arriving from the other direction.
        if (isPollInterval(data.deploy_poll_interval)) {
          setPollInterval(data.deploy_poll_interval);
        }
        setPrefsLoad("ready");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setPrefsLoad(err instanceof Error ? err.message : "Errore di rete");
      });
    return () => controller.abort();
  }, [prefsAttempt, me.isOwner]);

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
      if (res.ok) {
        toast.success("Preferenze salvate");
        setZoneSaved(true);
        setEffectiveZone(timezone);
      }
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
      <PageHeader title="Pannello" description="Preferenze e integrazioni, per tutti gli account" />

      <div className="max-w-3xl space-y-4">
        {me.isOwner && (
          <Panel className="space-y-4">
            <PanelHeader title="Preferenze" description="Come si comporta il pannello, per tutti gli account" />

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

            <div>
              <TextField value={timezone} onChange={setTimezone}>
                <Label>Fuso orario</Label>
                <Input placeholder="Europe/Rome" />
              </TextField>
              <FieldHint>
                {zoneSaved && effectiveZone === timezone ? (
                  <>
                    Le pianificazioni, backup e riavvii programmati, seguono l&apos;ora di{" "}
                    <Code>{effectiveZone}</Code>.
                  </>
                ) : (
                  <>
                    Le pianificazioni, backup e riavvii programmati, usano ora{" "}
                    <Code>{effectiveZone ?? "UTC"}</Code>
                    {zoneSaved ? "" : ": nessun fuso è stato ancora salvato"}. Salva per passare a{" "}
                    <Code>{timezone || "UTC"}</Code>; i prossimi riavvii vengono ricalcolati.
                  </>
                )}
            </FieldHint>
          </div>

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

            {prefsLoad !== "loading" && prefsLoad !== "ready" && (
              <LoadError
                what="le preferenze salvate"
                error={prefsLoad}
                onRetry={() => {
                  setPrefsLoad("loading");
                  setPrefsAttempt((n) => n + 1);
                }}
              />
            )}

            <div>
              <Button
                variant="primary"
                isPending={prefsSaving}
                isDisabled={prefsLoad !== "ready"}
                onPress={savePrefs}
              >
                Salva preferenze
              </Button>
            </div>
          </Panel>
        )}

        {me.isOwner && (
          <Section title="Colore d'accento" summary="Il colore delle azioni principali e della selezione">
            <AccentPicker />
            <FieldHint>
              Vale per tutti gli account; chiaro o scuro si sceglie in Account, per browser. Gli
              stati (in esecuzione, deploy, errore) restano identici in ogni preset: un tema non
              deve poter rendere indistinguibili due situazioni diverse.
            </FieldHint>
          </Section>
        )}

        {canNotify && (
          <Section
            title="Notifiche Telegram"
            summary="Crash, esiti dei deploy, backup e aggiornamenti, su un bot"
          >
            <NotificationSettings />
          </Section>
        )}

        {canRegistries && (
          <Section title="Registry privati" summary="Credenziali per pull e build di immagini private">
            <RegistryList />
          </Section>
        )}
      </div>
    </>
  );
}
