/**
 * The single source of truth for how a status looks.
 *
 * There used to be four independent maps — one in StatusBadge, one in the home
 * page, and two in the monitor page (the same map written twice in one file) —
 * which is why a "running" dot and a "running" chip could disagree. Everything
 * that renders a status now goes through here.
 */

export type StatusTone = "success" | "warning" | "danger" | "neutral";

export type KnownStatus =
  | "running"
  | "stopped"
  | "deploying"
  | "error"
  | "pending"
  | "building"
  | "failed"
  | "superseded"
  | "checking"
  | "success"
  | "partial"
  | "canceled"
  | "skipped";

interface StatusMeta {
  tone: StatusTone;
  label: string;
  /** Whether the indicator should pulse — reserved for genuinely in-flight states. */
  active?: boolean;
}

const STATUS_META: Record<KnownStatus, StatusMeta> = {
  running: { tone: "success", label: "Running" },
  stopped: { tone: "neutral", label: "Stopped" },
  deploying: { tone: "warning", label: "Deploying", active: true },
  building: { tone: "warning", label: "Building", active: true },
  pending: { tone: "neutral", label: "Pending", active: true },
  checking: { tone: "neutral", label: "Checking", active: true },
  error: { tone: "danger", label: "Error" },
  failed: { tone: "danger", label: "Failed" },
  superseded: { tone: "neutral", label: "Completed" },
  success: { tone: "success", label: "Riuscito" },
  // A backup where some targets failed still has value, so it is not an error —
  // but it must not read as a clean night either.
  partial: { tone: "warning", label: "Parziale" },
  canceled: { tone: "neutral", label: "Annullato" },
  skipped: { tone: "neutral", label: "Saltato" },
};

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status as KnownStatus] ?? STATUS_META.stopped;
}

export function statusTone(status: string): StatusTone {
  return statusMeta(status).tone;
}

/** Tailwind classes per tone, so text, dots and chips stay in step. */
export const TONE_TEXT: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-muted",
};

export const TONE_DOT: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-muted",
};

export const TONE_SOFT: Record<StatusTone, string> = {
  success: "text-success bg-success/10",
  warning: "text-warning bg-warning/10",
  danger: "text-danger bg-danger/10",
  neutral: "text-muted bg-default",
};
