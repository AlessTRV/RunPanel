/**
 * The Telegram Bot API, in the two and a half calls this panel needs.
 *
 * Outbound only, which is the whole reason this is the right channel here. A
 * self-hosted panel very often lives where nothing can reach it — behind NAT,
 * on a Tailscale network, on a laptop — and the same argument that made
 * `services/deploy-poll.ts` exist applies to notifications: a channel that
 * needs an inbound webhook does not work, and one that only ever dials out
 * works from anywhere with an internet connection.
 *
 * The cost is that the bot cannot be talked *to*. There are no commands, no
 * buttons that do anything; `getUpdates` is used once, on demand, only so the
 * settings screen can find the chat id without asking somebody to talk to
 * @userinfobot first.
 */

const API = "https://api.telegram.org";

/** Long enough for a slow network, short enough not to hold a deploy's tail. */
const TIMEOUT_MS = 10_000;

export interface TelegramResult {
  ok: boolean;
  /** Telegram's own wording, which is usually the useful part. */
  error?: string;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

async function call<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>
): Promise<TelegramResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });

    // Telegram answers 4xx with a JSON body that explains itself far better
    // than the status code does, so the body is read either way.
    const json = (await res.json()) as TelegramResponse<T>;
    return json;
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      description: aborted ? `Nessuna risposta entro ${TIMEOUT_MS / 1000}s` : reason(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function reason(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Telegram's `description` field, translated where it is famously unhelpful.
 *
 * "chat not found" is the one everybody hits, and on its own it sounds like a
 * bug in the panel rather than the one thing the operator has to do.
 */
function explain(description: string | undefined, chatId: string): string {
  const text = description ?? "errore sconosciuto";

  if (/chat not found/i.test(text)) {
    return `Chat ${chatId} non trovata. Apri una conversazione con il bot e mandagli un messaggio qualsiasi: finché non gli scrivi tu, un bot non può scriverti.`;
  }
  if (/bot was blocked/i.test(text)) {
    return "Il bot è stato bloccato da questa chat.";
  }
  if (/unauthorized/i.test(text)) {
    return "Token del bot rifiutato: ricontrollalo con @BotFather.";
  }
  if (/can't parse entities/i.test(text)) {
    // Ours to fix, not the operator's, so say so rather than showing the raw
    // parser complaint.
    return `Messaggio rifiutato dal parser di Telegram (${text}). È un bug di formattazione del pannello.`;
  }
  return text;
}

export async function sendMessage(
  token: string,
  chatId: string,
  html: string
): Promise<TelegramResult> {
  const res = await call<unknown>(token, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    // A notification about a deploy should not unfurl the repository link into
    // a card that is taller than the message.
    link_preview_options: { is_disabled: true },
  });

  if (res.ok) return { ok: true };
  return { ok: false, error: explain(res.description, chatId) };
}

export interface BotIdentity {
  id: number;
  username: string | null;
  name: string | null;
}

/** Who this token belongs to — the cheapest way to check it is valid. */
export async function getMe(token: string): Promise<{ ok: boolean; bot?: BotIdentity; error?: string }> {
  const res = await call<{ id: number; username?: string; first_name?: string }>(token, "getMe");
  if (!res.ok || !res.result) {
    return { ok: false, error: explain(res.description, "") };
  }
  return {
    ok: true,
    bot: {
      id: res.result.id,
      username: res.result.username ?? null,
      name: res.result.first_name ?? null,
    },
  };
}

export interface TelegramChat {
  id: string;
  title: string;
  kind: string;
}

/**
 * The chats that have written to this bot recently.
 *
 * The one piece of friction in setting a bot up is finding the chat id, and
 * every guide answers it with "message @userinfobot" or "open this URL in your
 * browser and read the JSON". The panel can just look: send the bot a message,
 * press the button, pick your name from the list.
 *
 * `getUpdates` returns nothing once a webhook is registered on the bot, and
 * nothing for messages older than 24 hours. Both are reported as "no chats
 * found" with the instruction to write to it, which is the right next step in
 * either case.
 */
export async function discoverChats(token: string): Promise<{ ok: boolean; chats?: TelegramChat[]; error?: string }> {
  /** A channel post has no `first_name`; a private chat has no `title`. */
  interface Chat {
    id: number;
    type?: string;
    title?: string;
    username?: string;
    first_name?: string;
  }
  interface Update {
    message?: { chat?: Chat };
    channel_post?: { chat?: Chat };
  }

  const res = await call<Update[]>(token, "getUpdates", { limit: 100, timeout: 0 });
  if (!res.ok || !res.result) return { ok: false, error: explain(res.description, "") };

  const seen = new Map<string, TelegramChat>();
  for (const update of res.result) {
    const chat = update.message?.chat ?? update.channel_post?.chat;
    if (!chat) continue;
    const id = String(chat.id);
    if (seen.has(id)) continue;
    seen.set(id, {
      id,
      title: chat.title ?? chat.first_name ?? (chat.username ? `@${chat.username}` : id),
      kind: chat.type ?? "private",
    });
  }

  return { ok: true, chats: [...seen.values()] };
}
