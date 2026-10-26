import type { StatusTone } from "./status";

/** How a name's certificate status reads, on the Domains page and in a project's settings. */
export const HOST_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  pending: { label: "In attesa", tone: "neutral" },
  issuing: { label: "Certificato in arrivo", tone: "warning" },
  active: { label: "HTTPS attivo", tone: "success" },
  error: { label: "Errore", tone: "danger" },
};
