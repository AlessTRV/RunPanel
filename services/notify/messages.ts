/**
 * Everything the panel can announce, and the words for it.
 *
 * One file, and with no imports at all, for the reason
 * `services/autostart/render.ts` gives about itself: the unit suite loads it
 * directly with Node's strip-only TypeScript loader, which resolves neither the
 * `@/` alias nor an extensionless relative path. Everything here is a pure
 * function of its argument.
 *
 * It is also one file because the two halves are inseparable in practice. The
 * catalogue below decides what to say; the escaping above decides whether it
 * arrives at all — none of the text in a notification is written by the panel,
 * and a single unescaped `<` in a commit subject does not degrade the
 * formatting, it makes Telegram reject the whole message.
 */

export type NotifyLevel = "ok" | "warn" | "danger" | "info";

export interface NotifyMessage {
  /** The line the phone shows in the notification list. */
  title: string;
  /** Telegram-flavoured HTML. */
  body: string;
  level: NotifyLevel;
}

const ICONS: Record<NotifyLevel, string> = {
  ok: "✅",
  warn: "⚠️",
  danger: "🔴",
  info: "ℹ️",
};

/**
 * The four characters Telegram's HTML parser cares about.
 *
 * Not a general HTML escape: `'` and `"` are left alone on purpose, because
 * Telegram does not need them escaped and turning every apostrophe in an
 * Italian sentence into `&#39;` is how a message ends up unreadable.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Monospace, for a sha, a slug or a path. */
export function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
}

export function bold(value: string): string {
  return `<b>${escapeHtml(value)}</b>`;
}

/**
 * Telegram rejects a message over 4096 characters outright, so a long stack
 * trace would lose the whole notification rather than its tail.
 */
export const MAX_MESSAGE_LENGTH = 4096;

export function clamp(text: string, limit = MAX_MESSAGE_LENGTH): string {
  if (text.length <= limit) return text;
  const suffix = "\n…";
  return `${text.slice(0, limit - suffix.length)}${suffix}`;
}

/**
 * An error as one readable line.
 *
 * Build output arrives with newlines, ANSI colour and a stack; on a phone the
 * useful part is the first line and nothing else fits anyway.
 */
export function firstLine(text: string, limit = 300): string {
  // ESC, `[`, parameters, `m` — an ANSI colour sequence, which build output
  // is full of. Written as an escape rather than as the byte itself: a literal
  // control character in a source file is invisible in every diff.
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const line = clean.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** "1 m 12 s", for a duration nobody wants in milliseconds. */
export function duration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${seconds % 60} s`;
}

export function bytes(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/**
 * Assemble the final text.
 *
 * The title is repeated as the first line rather than relying on Telegram to
 * show one: a notification preview is the first line of the body, so a message
 * that opened with a detail would preview as that detail.
 */
export function render(message: NotifyMessage, footer?: string): string {
  const head = `${ICONS[message.level]} ${bold(message.title)}`;
  const parts = [head, message.body.trim()].filter(Boolean);
  if (footer) parts.push(footer);
  return clamp(parts.join("\n\n"));
}

// --- The catalogue ---------------------------------------------------------

export type DeployTrigger = "manual" | "webhook" | "poll";

export type NotifyEvent =
  | {
      key: "project.crashed";
      slug: string;
      /** What the panel believed before it looked. */
      runtime: string;
    }
  | { key: "service.crashed"; name: string; container: string }
  /** `up` is the direction: false when it went away, true when it came back. */
  | { key: "docker.down"; up: boolean; detail?: string }
  | { key: "disk.low"; up: boolean; freeBytes: number; totalBytes: number; path: string }
  | {
      key: "deploy.finished";
      slug: string;
      ok: boolean;
      trigger: DeployTrigger;
      commitSha: string | null;
      commitMessage: string | null;
      durationMs: number | null;
      error: string | null;
    }
  | {
      key: "backup.finished";
      policy: string | null;
      status: string;
      ok: number;
      failed: number;
      skipped: number;
      bytes: number;
      durationMs: number | null;
      error: string | null;
    }
  | {
      key: "panel.update";
      behind: number;
      from: string | null;
      to: string | null;
      branch: string | null;
    }
  | { key: "panel.restarted"; version: string; sha: string | null; afterUpdate: boolean };

/**
 * Whether a finished deploy is news.
 *
 * A deploy from a webhook or from the periodic check happened while nobody was
 * watching — that is the entire point of automating it — so its outcome is
 * something to be told. One launched by hand from the panel is already on
 * screen, with its log streaming, and announcing it would be the panel telling
 * you what you are looking at. Unless it failed: a failure is worth having on
 * your phone even if you started it, because you have probably closed the tab.
 */
export function shouldAnnounceDeploy(trigger: DeployTrigger, ok: boolean): boolean {
  return trigger !== "manual" || !ok;
}

/**
 * Ten percent free, with a two-point gap before it counts as recovered.
 *
 * The gap is the whole design. Without it a disk hovering at exactly the
 * threshold — which is precisely what a disk that is filling up does — crosses
 * back and forth on every tick and sends a warning and an all-clear,
 * alternating, forever. `wasLow` is what the previous reading concluded.
 */
export const DISK_LOW_RATIO = 0.10;
export const DISK_RECOVERED_RATIO = 0.12;

export function diskLow(free: number, total: number, wasLow: boolean | undefined): boolean {
  if (total <= 0) return false;
  const ratio = free / total;
  return wasLow ? ratio < DISK_RECOVERED_RATIO : ratio < DISK_LOW_RATIO;
}

const TRIGGERS: Record<DeployTrigger, string> = {
  manual: "manuale",
  webhook: "webhook",
  poll: "controllo periodico",
};

/** "1 saltato", "2 saltati" — one artefact is not "1 saltati". */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A `label: value` line, skipped entirely when there is no value. */
function line(label: string, value: string | null | undefined): string | null {
  return value ? `${label}: ${value}` : null;
}

function join(parts: (string | null)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join("\n");
}

export function describe(event: NotifyEvent): NotifyMessage {
  switch (event.key) {
    case "project.crashed":
      return {
        level: "danger",
        title: "Progetto fermo",
        body: join([
          `${bold(event.slug)} non è più in esecuzione, e non è stato il pannello a fermarlo.`,
          line("Runtime", code(event.runtime)),
          "Il pannello non lo riavvia da solo: l'ho scritto nello stato, decidi tu.",
        ]),
      };

    case "service.crashed":
      return {
        level: "danger",
        title: "Servizio fermo",
        body: join([
          `${bold(event.name)} non è più in esecuzione, e non è stato il pannello a fermarlo.`,
          line("Container", code(event.container)),
          "Un progetto collegato a questo servizio probabilmente non riesce più a connettersi.",
        ]),
      };

    case "docker.down":
      return event.up
        ? {
            level: "ok",
            title: "Docker risponde di nuovo",
            body: "Il daemon è tornato raggiungibile. I container che avevano una restart policy dovrebbero essere già tornati su.",
          }
        : {
            level: "danger",
            title: "Docker non risponde",
            body: join([
              "Il daemon è irraggiungibile: niente container, niente provisioning di database, niente dump nei backup.",
              line("Dettaglio", event.detail ? code(firstLine(event.detail, 200)) : null),
            ]),
          };

    case "disk.low": {
      const free = bytes(event.freeBytes);
      const total = bytes(event.totalBytes);
      const percent =
        event.totalBytes > 0 ? Math.round((event.freeBytes / event.totalBytes) * 100) : 0;

      return event.up
        ? {
            level: "ok",
            title: "Spazio su disco rientrato",
            body: `Di nuovo ${free} liberi su ${total} (${percent}%).`,
          }
        : {
            level: "warn",
            title: "Spazio su disco quasi finito",
            body: join([
              `Restano ${bold(String(free))} su ${total} — il ${percent}%.`,
              line("Cartella", code(event.path)),
              "Sotto questa soglia i backup e le build cominciano a fallire senza preavviso.",
            ]),
          };
    }

    case "deploy.finished": {
      const commit = event.commitSha ? event.commitSha.slice(0, 7) : null;
      const details = join([
        line(
          "Commit",
          commit
            ? // Escaped explicitly: `code()` and `bold()` do it for what they
              // wrap, and a commit subject interpolated bare between them is
              // exactly the gap a `<` slips through.
              `${code(commit)} ${event.commitMessage ? escapeHtml(firstLine(event.commitMessage, 120)) : ""}`.trim()
            : null
        ),
        line("Trigger", TRIGGERS[event.trigger]),
        line("Durata", duration(event.durationMs)),
      ]);

      return event.ok
        ? {
            level: "ok",
            title: `Deploy riuscito — ${event.slug}`,
            body: join([details, "L'app risponde: health check superato."]),
          }
        : {
            level: "danger",
            title: `Deploy fallito — ${event.slug}`,
            body: join([
              details,
              line("Errore", event.error ? code(firstLine(event.error)) : null),
            ]),
          };
    }

    case "backup.finished": {
      const details = join([
        line("Pianificazione", event.policy),
        line(
          "Artefatti",
          [
            plural(event.ok, "riuscito", "riusciti"),
            plural(event.failed, "fallito", "falliti"),
            plural(event.skipped, "saltato", "saltati"),
          ].join(", ")
        ),
        line("Dimensione", bytes(event.bytes)),
        line("Durata", duration(event.durationMs)),
      ]);

      if (event.status === "success") {
        return { level: "ok", title: "Backup completato", body: details };
      }

      if (event.status === "partial") {
        return {
          level: "warn",
          title: "Backup completato solo in parte",
          body: join([
            details,
            "L'archivio esiste ma non contiene tutto: controlla quali artefatti mancano prima di contarci.",
          ]),
        };
      }

      return {
        level: "danger",
        title: "Backup fallito",
        body: join([details, line("Errore", event.error ? code(firstLine(event.error)) : null)]),
      };
    }

    case "panel.update":
      return {
        level: "info",
        title: "Aggiornamento di RunPanel disponibile",
        body: join([
          `${event.behind === 1 ? "1 commit nuovo" : `${event.behind} commit nuovi`}${event.branch ? ` su ${code(event.branch)}` : ""}.`,
          line(
            "Da / a",
            event.from && event.to ? `${code(event.from.slice(0, 7))} → ${code(event.to.slice(0, 7))}` : null
          ),
          "Si applica dal pannello, dalla pagina Aggiornamenti.",
        ]),
      };

    case "panel.restarted":
      return {
        level: event.afterUpdate ? "ok" : "info",
        title: event.afterUpdate ? "RunPanel aggiornato ed è tornato su" : "RunPanel è ripartito",
        body: join([
          line("Versione", `v${event.version}`),
          line("Commit", event.sha ? code(event.sha.slice(0, 7)) : null),
          event.afterUpdate
            ? null
            : "Se non l'hai riavviato tu, è caduto e il supervisore l'ha rimesso su.",
        ]),
      };
  }
}
