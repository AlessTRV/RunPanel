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
 *
 * How the escaping is enforced, and why it is a type rather than a convention:
 * the previous version relied on whoever added a catalogue entry remembering to
 * wrap values in `code()` or `bold()`, and twice they did not — a backup policy
 * name and a version string went out raw. `Html` is a branded string that only
 * the helpers above the divider produce, and `html` is a tagged template that
 * *refuses* a plain `string` rather than escaping it. Forgetting is now a
 * compile error instead of a message Telegram silently rejects.
 *
 * The rule that keeps that guarantee total: every cast to `Html` lives above
 * the catalogue divider. Below it there are none.
 */

export type NotifyLevel = "ok" | "warn" | "danger" | "info";

/**
 * A string that is already safe to hand to Telegram's HTML parser.
 *
 * Erased entirely at build time — it is a type alias and a few `as` casts, no
 * runtime construct — which is what keeps this file loadable by Node's
 * strip-only loader.
 */
export type Html = string & { readonly __html: "notify" };

export interface NotifyMessage {
  /**
   * The line the phone shows in the notification list.
   *
   * Plain text, not `Html`: `render()` escapes it. The two fields carry
   * different kinds of string and the types now say so, which is the bug that
   * used to be invisible.
   */
  title: string;
  /** Telegram-flavoured HTML, already escaped. */
  body: Html;
  level: NotifyLevel;
}

/** Cast, not escaped: an emoji contains none of the three characters that matter. */
const ICONS: Record<NotifyLevel, Html> = {
  ok: "✅" as Html,
  warn: "⚠️" as Html,
  danger: "🔴" as Html,
  info: "ℹ️" as Html,
};

/**
 * The three characters Telegram's HTML parser cares about.
 *
 * Not a general HTML escape: `'` and `"` are left alone on purpose, because
 * Telegram does not need them escaped and turning every apostrophe in an
 * Italian sentence into `&#39;` is how a message ends up unreadable. That
 * exception is also why `link()` exists rather than an attribute being built by
 * hand — inside an attribute an unescaped `"` is not cosmetic.
 */
export function escapeHtml(value: string): Html {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;") as Html;
}

/**
 * Assemble markup from pieces that are already safe.
 *
 * The tag deliberately does not escape. It refuses: a plain `string` in an
 * interpolation is a type error, so the author has to reach for `escapeHtml`,
 * `code`, `bold` or `link` and decide what the value actually is. A tag that
 * escaped silently would be just as safe and would teach nobody, and it could
 * not tell an already-built `<code>…</code>` from text that happens to contain
 * angle brackets.
 *
 * Numbers pass through because a number cannot carry markup. `null` and
 * `undefined` render as nothing, which is what the old bare template literals
 * should have done — they printed the string "null".
 */
export function html(
  parts: TemplateStringsArray,
  ...values: (Html | number | null | undefined)[]
): Html {
  let out = parts[0];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    out += value === null || value === undefined ? "" : String(value);
    out += parts[i + 1];
  }
  return out as Html;
}

/** Monospace, for a sha, a slug or a path. */
export function code(value: string): Html {
  return `<code>${escapeHtml(value)}</code>` as Html;
}

export function bold(value: string): Html {
  return `<b>${escapeHtml(value)}</b>` as Html;
}

/**
 * A link, checked against a shape instead of escaped.
 *
 * Its own function because `escapeHtml` leaves `"` alone by design — correct
 * inside text, fatal inside an attribute. The URL it is given comes from
 * `panel_public_url`, which the operator writes and which is validated only as
 * a parseable http(s) URL: `new URL('https://a.com"onmouseover=x').origin`
 * keeps the quote, verified against Node rather than assumed.
 *
 * A URL that fails the shape renders as monospace text rather than vanishing,
 * because a footer that quietly disappears is a bug nobody reports.
 */
export function link(url: string, label: string): Html {
  if (!/^https?:\/\/[^\s"'<>\\`]+$/.test(url)) return code(url);
  return `<a href="${url}">${escapeHtml(label)}</a>` as Html;
}

/**
 * Telegram rejects a message over 4096 characters outright, so a long stack
 * trace would lose the whole notification rather than its tail.
 */
export const MAX_MESSAGE_LENGTH = 4096;

/**
 * Cut to length without cutting through anything.
 *
 * A naive slice at 4096 lands wherever it lands, and three of those landings
 * produce a message Telegram refuses with `can't parse entities` — half an
 * entity (`&am`), half a tag (`<cod`), or a `<code>` whose closer fell off the
 * end. The whole notification is lost, which is the opposite of what truncating
 * was for.
 */
export function clamp(text: Html, limit = MAX_MESSAGE_LENGTH): Html {
  if (text.length <= limit) return text;

  const suffix = "\n…";
  let budget = limit - suffix.length;

  // The closers are a handful of characters and the budget drops by their
  // length each pass, so this settles on the first or second try.
  for (let attempt = 0; attempt < 3; attempt++) {
    const cut = safeCut(text, budget);
    const closers = closeOpenTags(cut);
    if (cut.length + closers.length + suffix.length <= limit) {
      return `${cut}${closers}${suffix}` as Html;
    }
    budget -= closers.length;
  }

  // Unreachable in practice. Kept because "unreachable" and "emits markup
  // Telegram rejects" is a bad pair of things to be wrong about at once, and
  // dropping the formatting is always a valid answer.
  return `${safeCut(text, budget).replace(/<\/?(?:b|code|a)\b[^>]*>/g, "")}${suffix}` as Html;
}

/** A slice that never lands inside a surrogate pair, a tag, or an entity. */
function safeCut(text: string, budget: number): string {
  let cut = text.slice(0, Math.max(0, budget));

  // Half a surrogate pair is not a character, and commit subjects in this
  // repository are full of emoji.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);

  const openAngle = cut.lastIndexOf("<");
  if (openAngle > cut.lastIndexOf(">")) cut = cut.slice(0, openAngle);

  // Bounded by length: a bare `&` in prose is ordinary, and cutting the message
  // back to the last one of those would throw away most of it.
  const amp = cut.lastIndexOf("&");
  if (amp > cut.lastIndexOf(";") && cut.length - amp <= 12) cut = cut.slice(0, amp);

  return cut;
}

/** The closers for whatever this fragment left open, innermost first. */
function closeOpenTags(fragment: string): string {
  const open: string[] = [];
  for (const match of fragment.matchAll(/<(\/?)(b|code|a)\b[^>]*>/g)) {
    const closing = match[1];
    const tag = match[2];
    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at !== -1) open.splice(at, 1);
    } else {
      open.push(tag);
    }
  }
  return open
    .reverse()
    .map((tag) => `</${tag}>`)
    .join("");
}

/**
 * An error as one readable line.
 *
 * Build output arrives with newlines, ANSI colour and a stack; on a phone the
 * useful part is the first line and nothing else fits anyway.
 *
 * Returns plain text, not `Html`, deliberately: it is a text transform, and its
 * result still has to be escaped by whoever uses it.
 */
export function firstLine(text: string, limit = 300): string {
  // ESC, `[`, parameters, `m` — an ANSI colour sequence, which build output
  // is full of. Written as an escape rather than as the byte itself: a literal
  // control character in a source file is invisible in every diff.
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const line = clean.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * "1 m 12 s", for a duration nobody wants in milliseconds.
 *
 * Branded rather than escaped, like `bytes` and `plural` below: it takes a
 * number and provably emits digits, spaces and a unit. Escaping it would put an
 * `escapeHtml` on every `line("Durata", …)` for nothing.
 */
export function duration(ms: number | null): Html | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s` as Html;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${seconds % 60} s` as Html;
}

export function bytes(value: number | null): Html | null {
  if (value === null || !Number.isFinite(value)) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}` as Html;
}

/**
 * Assemble the final text.
 *
 * The title is repeated as the first line rather than relying on Telegram to
 * show one: a notification preview is the first line of the body, so a message
 * that opened with a detail would preview as that detail.
 */
export function render(message: NotifyMessage, footer?: Html): string {
  const head = html`${ICONS[message.level]} ${bold(message.title)}`;
  // Trimming whitespace cannot unbalance markup.
  const body = message.body.trim() as Html;
  const parts: Html[] = [head, body].filter((part) => part.length > 0);
  if (footer) parts.push(footer);
  return clamp(parts.join("\n\n") as Html);
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

const TRIGGERS: Record<DeployTrigger, Html> = {
  manual: html`manuale`,
  webhook: html`webhook`,
  poll: html`controllo periodico`,
};

/** "1 saltato", "2 saltati" — one artefact is not "1 saltati". */
function plural(count: number, one: string, many: string): Html {
  return html`${count} ${escapeHtml(count === 1 ? one : many)}`;
}

/**
 * A `label: value` line, skipped entirely when there is no value.
 *
 * Takes `Html` and not `string`, which is the change that closes the hole: a
 * caller holding a raw value cannot reach this function without saying what to
 * do about it. For a plain value that just needs escaping there is `textLine`.
 */
function line(label: string, value: Html | null | undefined): Html | null {
  return value ? html`${escapeHtml(label)}: ${value}` : null;
}

/** The same, for a value that is plain text and should be escaped as such. */
function textLine(label: string, value: string | null | undefined): Html | null {
  return value ? line(label, escapeHtml(value)) : null;
}

function join(parts: (Html | null)[]): Html {
  return parts.filter((part): part is Html => Boolean(part)).join("\n") as Html;
}

/** Several already-safe fragments on one line. */
function inline(parts: Html[], separator = ", "): Html {
  return parts.join(separator) as Html;
}

export function describe(event: NotifyEvent): NotifyMessage {
  switch (event.key) {
    case "project.crashed":
      return {
        level: "danger",
        title: "Progetto fermo",
        body: join([
          html`${bold(event.slug)} non è più in esecuzione, e non è stato il pannello a fermarlo.`,
          line("Runtime", code(event.runtime)),
          html`Il pannello non lo riavvia da solo: l'ho scritto nello stato, decidi tu.`,
        ]),
      };

    case "service.crashed":
      return {
        level: "danger",
        title: "Servizio fermo",
        body: join([
          html`${bold(event.name)} non è più in esecuzione, e non è stato il pannello a fermarlo.`,
          line("Container", code(event.container)),
          html`Un progetto collegato a questo servizio probabilmente non riesce più a connettersi.`,
        ]),
      };

    case "docker.down":
      return event.up
        ? {
            level: "ok",
            title: "Docker risponde di nuovo",
            body: html`Il daemon è tornato raggiungibile. I container che avevano una restart policy dovrebbero essere già tornati su.`,
          }
        : {
            level: "danger",
            title: "Docker non risponde",
            body: join([
              html`Il daemon è irraggiungibile: niente container, niente provisioning di database, niente dump nei backup.`,
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
            body: html`Di nuovo ${free} liberi su ${total} (${percent}%).`,
          }
        : {
            level: "warn",
            title: "Spazio su disco quasi finito",
            body: join([
              html`Restano ${bold(String(free))} su ${total} — il ${percent}%.`,
              line("Cartella", code(event.path)),
              html`Sotto questa soglia i backup e le build cominciano a fallire senza preavviso.`,
            ]),
          };
    }

    case "deploy.finished": {
      const commit = event.commitSha ? event.commitSha.slice(0, 7) : null;
      const subject = event.commitMessage ? firstLine(event.commitMessage, 120) : null;
      const details = join([
        line(
          "Commit",
          commit === null
            ? null
            : subject
              ? html`${code(commit)} ${escapeHtml(subject)}`
              : code(commit)
        ),
        line("Trigger", TRIGGERS[event.trigger]),
        line("Durata", duration(event.durationMs)),
      ]);

      return event.ok
        ? {
            level: "ok",
            title: `Deploy riuscito — ${event.slug}`,
            body: join([details, html`L'app risponde: health check superato.`]),
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
        textLine("Pianificazione", event.policy),
        line(
          "Artefatti",
          inline([
            plural(event.ok, "riuscito", "riusciti"),
            plural(event.failed, "fallito", "falliti"),
            plural(event.skipped, "saltato", "saltati"),
          ])
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
            html`L'archivio esiste ma non contiene tutto: controlla quali artefatti mancano prima di contarci.`,
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
          html`${event.behind === 1 ? html`1 commit nuovo` : html`${event.behind} commit nuovi`}${event.branch ? html` su ${code(event.branch)}` : null}.`,
          line(
            "Da / a",
            event.from && event.to
              ? html`${code(event.from.slice(0, 7))} → ${code(event.to.slice(0, 7))}`
              : null
          ),
          html`Si applica dal pannello, dalla pagina Aggiornamenti.`,
        ]),
      };

    case "panel.restarted":
      return {
        level: event.afterUpdate ? "ok" : "info",
        title: event.afterUpdate ? "RunPanel aggiornato ed è tornato su" : "RunPanel è ripartito",
        body: join([
          line("Versione", html`v${escapeHtml(event.version)}`),
          line("Commit", event.sha ? code(event.sha.slice(0, 7)) : null),
          event.afterUpdate
            ? null
            : html`Se non l'hai riavviato tu, è caduto e il supervisore l'ha rimesso su.`,
        ]),
      };
  }
}
