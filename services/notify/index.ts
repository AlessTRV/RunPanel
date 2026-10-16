import { getSetting, setSetting } from "@/lib/settings";
import { tryDecrypt } from "@/lib/crypto";
import { panelBaseUrl } from "@/lib/panel-url";
import { writeSharedSetting } from "@/services/cluster/directory";
import { broadcastDirectory } from "@/services/cluster/sync";
import {
  NOTIFY_EVENTS_SETTING,
  TELEGRAM_CHAT_SETTING,
  TELEGRAM_TOKEN_SETTING,
  parseNotifyEvents,
  type NotifyEventKey,
} from "@/lib/notify-events";
import { describe, escapeHtml, link, render, type Html, type NotifyEvent, type NotifyMessage } from "./messages";
import { clusterState, getMember } from "@/services/cluster/state";
import { sendMessage } from "./telegram";

/**
 * The one door out of the panel for "something happened that you would want to
 * know about".
 *
 * Everything about this function is arranged around a single rule: **a
 * notification must never be able to break the thing it is reporting on.** It
 * is called from inside a deploy, from a backup run and from a background
 * sweep, and every one of those is code where an unhandled rejection is a real
 * problem. So it never throws, never rejects, and never makes its caller wait —
 * callers use `void notify(...)` and carry on.
 *
 * The channel is Telegram and the transport lives next door. Adding a second
 * one later is a change in this file and nowhere else, which is the reason the
 * subsystems emit *events* rather than strings.
 */

export interface NotifyConfig {
  token: string | null;
  chatId: string | null;
  events: NotifyEventKey[];
}

export async function readConfig(): Promise<NotifyConfig> {
  const [stored, chatId, events] = await Promise.all([
    getSetting(TELEGRAM_TOKEN_SETTING),
    getSetting(TELEGRAM_CHAT_SETTING),
    getSetting(NOTIFY_EVENTS_SETTING),
  ]);

  return {
    // A decryption failure means the panel secret changed under a token
    // encrypted with the old one. Indistinguishable from "not configured" as
    // far as every caller is concerned, and reported the same way.
    token: stored ? tryDecrypt(stored) : null,
    chatId: chatId || null,
    events: parseNotifyEvents(events),
  };
}

export async function writeConfig(patch: {
  token?: string | null;
  chatId?: string | null;
  events?: NotifyEventKey[];
}): Promise<void> {
  // The bot and chat are shared across the cluster; which events to send stays
  // per server, since each one reports on its own projects.
  if (patch.token !== undefined) {
    await writeSharedSetting(TELEGRAM_TOKEN_SETTING, patch.token || null);
  }
  if (patch.chatId !== undefined) {
    await writeSharedSetting(TELEGRAM_CHAT_SETTING, patch.chatId || null);
  }
  if (patch.events !== undefined) {
    await setSetting(NOTIFY_EVENTS_SETTING, JSON.stringify(patch.events));
  }
  if (patch.token !== undefined || patch.chatId !== undefined) void broadcastDirectory();
}

export function isConfigured(config: NotifyConfig): boolean {
  return Boolean(config.token && config.chatId);
}

/**
 * How long the same event has to stay quiet after it has been sent.
 *
 * This is the difference between a useful channel and one that gets muted. A
 * project under a restart policy that crash-loops flaps stopped/running every
 * few seconds, and the status sweep reports each flap honestly; without a
 * cooldown that is a message every thirty seconds until somebody notices. The
 * first one says everything the twentieth would.
 *
 * Keyed per event *and per subject*, so a crash-looping project does not
 * silence a different one that falls over at the same time.
 */
const COOLDOWN_MS = 15 * 60_000;

/** In memory on purpose: losing it on restart costs one duplicate message. */
const globalRef = globalThis as typeof globalThis & {
  __runpanelNotifySent?: Map<string, number>;
};

function cooldownKey(event: NotifyEvent): string {
  switch (event.key) {
    case "project.crashed":
      return `${event.key}:${event.slug}`;
    case "service.crashed":
      return `${event.key}:${event.name}`;
    case "restart.scheduled":
      // Never suppressed: a schedule fires at most once per occurrence, and
      // two occurrences minutes apart are two things that happened.
      return "";
    case "docker.down":
      return `${event.key}:${event.up ? "up" : "down"}`;
    case "disk.low":
      // Per disk and per level, and per policy for a backup that will not fit:
      // a disk going from low to critical is new, and so is a second policy.
      if ("backup" in event) return `${event.key}:backup:${event.backup.policy}:${event.up ? "up" : "down"}`;
      return `${event.key}:${event.scope ?? "data"}:${event.level ?? (event.up ? "ok" : "low")}`;
    case "deploy.finished":
      // Never suppressed: two deploys of the same project minutes apart are two
      // pieces of news, and a deploy is something a person just caused.
      return "";
    case "backup.finished":
      return "";
    case "panel.update":
      return `${event.key}:${event.to ?? ""}`;
    case "panel.restarted":
      return event.key;
  }
}

function suppressed(event: NotifyEvent, now: number): boolean {
  const key = cooldownKey(event);
  if (!key) return false;

  const sent = (globalRef.__runpanelNotifySent ??= new Map());
  const last = sent.get(key);
  if (last !== undefined && now - last < COOLDOWN_MS) return true;

  sent.set(key, now);

  // The map is keyed by subject, so a panel that has seen a hundred projects
  // come and go would otherwise keep a hundred entries forever.
  if (sent.size > 200) {
    for (const [candidate, at] of sent) {
      if (now - at >= COOLDOWN_MS) sent.delete(candidate);
    }
  }

  return false;
}

/**
 * A link back to the panel, when it knows its own address.
 *
 * Only when `panel_public_url` is set: everywhere else in the panel an absolute
 * URL is built from the request, and there is no request here. Guessing would
 * produce a link to `localhost` on somebody's phone.
 */
async function footer(): Promise<Html | undefined> {
  // No request to fall back on, which is exactly the caller `panelBaseUrl` was
  // left optional for. Without the setting there is nothing honest to link to:
  // guessing would put a link to localhost on somebody's phone.
  const base = await panelBaseUrl();
  // Through `link()` rather than built here: this is the only HTML *attribute*
  // the panel writes, and `escapeHtml` deliberately leaves `"` alone. The origin
  // comes from an operator-set setting, and `new URL()` does not remove a quote
  // from a hostname it could not parse strictly.
  return base ? link(base.origin, "Apri RunPanel") : undefined;
}

/**
 * In a cluster every server notifies through the same bot, so each message
 * starts with the name of the server that sent it. Null in solo mode.
 */
async function serverName(): Promise<string | null> {
  try {
    const state = await clusterState();
    if (!state) return null;
    return (await getMember(state.selfId))?.name ?? null;
  } catch {
    return null;
  }
}

async function withServer(message: NotifyMessage): Promise<NotifyMessage> {
  const name = await serverName();
  return name ? { ...message, title: `${name} · ${message.title}` } : message;
}

/**
 * Announce an event, if the operator asked for this kind and a bot is
 * configured. Fire-and-forget: callers do not await it and nothing observes
 * the result but the log.
 */
export async function notify(event: NotifyEvent): Promise<void> {
  try {
    const config = await readConfig();
    if (!isConfigured(config)) return;
    if (!config.events.includes(event.key)) return;
    if (suppressed(event, Date.now())) return;

    const result = await sendMessage(
      config.token!,
      config.chatId!,
      render(await withServer(describe(event)), await footer())
    );

    if (!result.ok) {
      console.warn(`[notify] ${event.key} non consegnato: ${result.error}`);
    }
  } catch (err) {
    // Reaching here means something the panel does not control went wrong —
    // the store, the network stack. It must not surface as a failed deploy.
    console.error("[notify] Notifica non inviata:", err instanceof Error ? err.message : err);
  }
}

/** The test button. Reports its outcome, unlike `notify`. */
export async function sendTest(): Promise<{ ok: boolean; error?: string }> {
  const config = await readConfig();
  if (!config.token) return { ok: false, error: "Nessun token del bot configurato." };
  if (!config.chatId) return { ok: false, error: "Nessuna chat configurata." };

  const result = await sendMessage(
    config.token,
    config.chatId,
    render(
      await withServer({
        level: "ok",
        title: "RunPanel è collegato",
        body: escapeHtml(
          "Questa è una prova. Da qui in poi ti arrivano crash, esiti dei deploy, backup e aggiornamenti del pannello."
        ),
      }),
      await footer()
    )
  );

  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export type { NotifyEvent } from "./messages";
