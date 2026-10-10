import type { GlobalPermission, Level } from "@/lib/authz";

/** How permissions and levels read in the interface. */

export const PERMISSION_GROUPS: { title: string; items: { key: GlobalPermission; label: string; description: string }[] }[] = [
  {
    title: "Infrastruttura",
    items: [
      { key: "projects.create", label: "Crea progetti e servizi", description: "Chi crea un progetto o un servizio ne riceve la gestione." },
      { key: "github", label: "GitHub", description: "Usa il token salvato per elencare e clonare i repository." },
      { key: "registries", label: "Registry", description: "Usa e gestisce le credenziali dei registry privati." },
      { key: "storage", label: "Storage", description: "Vede e libera lo spazio di Docker." },
      { key: "backup", label: "Backup", description: "Pianifica e scarica i backup dei progetti e servizi che gestisce." },
      { key: "restore", label: "Ripristino", description: "Ripristina un backup: sovrascrive i dati, va dato con cura." },
    ],
  },
  {
    title: "Sistema",
    items: [
      { key: "monitor", label: "Monitor", description: "Metriche e uso delle risorse del server." },
      { key: "autostart", label: "Avvio automatico", description: "Cosa riparte quando riparte il server." },
      { key: "diagnostics", label: "Diagnostica", description: "Lo stato degli strumenti installati sul server." },
      { key: "notifications", label: "Notifiche", description: "Il bot Telegram e cosa notifica." },
      { key: "updates", label: "Aggiornamenti", description: "Controlla e installa le nuove versioni del pannello." },
      {
        key: "host",
        label: "Accesso all'host",
        description:
          "Runtime nativi, Compose, mount, comandi una tantum e modifica del codice: tutto ciò che esce dal container. Equivale a poter leggere ogni dato del pannello.",
      },
    ],
  },
  {
    title: "Amministrazione",
    items: [
      { key: "users.manage", label: "Gestione utenti", description: "Invita e modifica gli account che non hanno più accessi dei suoi." },
      { key: "audit.view", label: "Registro attività", description: "Consulta le attività sulle risorse che può vedere." },
    ],
  },
];

export const LEVEL_OPTIONS: { value: Level; label: string; description: string }[] = [
  { value: "read", label: "Lettura", description: "Stato, log e storico; variabili mascherate" },
  { value: "operate", label: "Operatore", description: "In più deploy, avvio, stop e riavvio" },
  { value: "manage", label: "Gestione", description: "In più impostazioni, variabili in chiaro ed eliminazione" },
];

export const LEVEL_LABEL: Record<Level, string> = { read: "Lettura", operate: "Operatore", manage: "Gestione" };

export const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  active: { label: "Attivo", tone: "text-success" },
  invited: { label: "Invito in attesa", tone: "text-accent" },
  invite_expired: { label: "Invito scaduto", tone: "text-warning" },
  disabled: { label: "Disattivato", tone: "text-muted" },
};

/** Lifetimes offered for a link, in hours. */
export const LINK_DURATIONS = [
  { value: "1", label: "1 ora" },
  { value: "24", label: "24 ore" },
  { value: "168", label: "7 giorni" },
  { value: "custom", label: "Personalizzata" },
] as const;
