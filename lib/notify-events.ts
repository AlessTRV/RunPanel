/**
 * What the panel is willing to tell you about, and how it is grouped.
 *
 * In `lib/` with no imports, because three places have to agree on this list
 * and one of them runs in the browser: the settings screen draws the toggles
 * from it, the API validates a saved selection against it, and the notifier
 * asks it whether an event is switched on. A second copy is how a screen ends
 * up offering a switch that turns nothing off.
 */

export const NOTIFY_EVENTS = [
  "project.crashed",
  "service.crashed",
  "docker.down",
  "disk.low",
  "deploy.finished",
  "backup.finished",
  "panel.update",
  "panel.restarted",
] as const;

export type NotifyEventKey = (typeof NOTIFY_EVENTS)[number];

export interface NotifyEventGroup {
  id: string;
  label: string;
  description: string;
  events: { key: NotifyEventKey; label: string; description: string }[];
}

/**
 * The four groups the operator actually thinks in. The individual switches stay
 * per-event so a single noisy one can be silenced without losing its neighbours.
 */
export const NOTIFY_GROUPS: NotifyEventGroup[] = [
  {
    id: "trouble",
    label: "Crash e problemi",
    description: "Qualcosa è caduto senza che il pannello lo avesse fermato",
    events: [
      {
        key: "project.crashed",
        label: "Un progetto si è fermato da solo",
        description:
          "Il processo non c'è più e il pannello non lo aveva fermato. Confermato su due letture, quindi un pm2 che non risponde per un istante non manda niente.",
      },
      {
        key: "service.crashed",
        label: "Un servizio si è fermato da solo",
        description: "Stessa cosa per un container di database.",
      },
      {
        key: "docker.down",
        label: "Docker non risponde",
        description:
          "Il daemon è irraggiungibile: niente container, niente provisioning, niente dump. Ti avvisa anche quando torna.",
      },
    ],
  },
  {
    id: "deploy",
    label: "Deploy",
    description: "Esito dei deploy dei progetti",
    events: [
      {
        key: "deploy.finished",
        label: "Deploy concluso",
        description:
          "Sempre per i deploy automatici, da webhook o da controllo periodico. Per quelli lanciati a mano solo se falliscono: quelli li stai già guardando.",
      },
    ],
  },
  {
    id: "backup",
    label: "Backup",
    description: "Esito delle esecuzioni di backup",
    events: [
      {
        key: "backup.finished",
        label: "Backup concluso",
        description:
          "Riuscito, parziale o fallito, con quanti artefatti e quanto pesano. Un backup notturno che fallisce in silenzio te ne accorgi il giorno che ti serve.",
      },
    ],
  },
  {
    id: "panel",
    label: "Pannello e host",
    description: "Lo stato di RunPanel e della macchina",
    events: [
      {
        key: "panel.update",
        label: "Aggiornamento del pannello disponibile",
        description: "Quando il controllo periodico trova commit nuovi su RunPanel.",
      },
      {
        key: "panel.restarted",
        label: "Il pannello è ripartito",
        description:
          "Dopo un riavvio o un aggiornamento. È anche il modo di accorgersi di un pannello che va in crash-loop.",
      },
      {
        key: "disk.low",
        label: "Spazio su disco quasi finito",
        description:
          "Sotto il 10% libero sulla cartella dei dati. È la cosa che ferma i backup e le build senza preavviso.",
      },
    ],
  },
];

/** The default selection for a panel that has just connected a bot. */
export const DEFAULT_NOTIFY_EVENTS: NotifyEventKey[] = [
  "project.crashed",
  "service.crashed",
  "docker.down",
  "disk.low",
  "deploy.finished",
  "backup.finished",
  "panel.update",
];

export function isNotifyEventKey(value: unknown): value is NotifyEventKey {
  return NOTIFY_EVENTS.includes(value as NotifyEventKey);
}

/**
 * Narrow whatever came out of the store, dropping anything no longer offered.
 *
 * A copy of the defaults, never the array itself: it is a module-level constant
 * shared by every caller, and one of them handing it to something that sorts or
 * pushes would change the defaults for the lifetime of the process.
 *
 * An empty stored list is honoured rather than treated as absent. Turning every
 * notification off has to be possible, and "no keys" is exactly how that looks.
 */
export function parseNotifyEvents(raw: string | null | undefined): NotifyEventKey[] {
  if (!raw) return [...DEFAULT_NOTIFY_EVENTS];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_NOTIFY_EVENTS];
    return parsed.filter(isNotifyEventKey);
  } catch {
    return [...DEFAULT_NOTIFY_EVENTS];
  }
}

export const NOTIFY_EVENTS_SETTING = "notify_events";
export const TELEGRAM_TOKEN_SETTING = "telegram_bot_token";
export const TELEGRAM_CHAT_SETTING = "telegram_chat_id";
