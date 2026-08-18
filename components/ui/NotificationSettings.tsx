"use client";

import { useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { SettingToggle } from "./SettingToggle";
import { FieldHint, Hint } from "./Hint";
import { SkeletonBlock } from "./Skeletons";
import { useResource } from "@/lib/hooks/useResource";
import { MSG } from "@/lib/copy";
import { NOTIFY_GROUPS, type NotifyEventKey } from "@/lib/notify-events";

interface Config {
  tokenSet: boolean;
  chatId: string;
  events: NotifyEventKey[];
  configured: boolean;
}

interface Chat {
  id: string;
  title: string;
  kind: string;
}

/**
 * Connecting a Telegram bot, and choosing what it is allowed to say.
 *
 * The awkward part of setting one of these up is not the token, it is the chat
 * id: every guide answers it with "message @userinfobot" or "open this URL and
 * read the JSON". The panel already holds the token, so it can just ask
 * Telegram who has written to the bot and offer the list — which turns the
 * whole setup into paste, write to the bot, press two buttons.
 *
 * The token is write-only from here. It goes back encrypted and never comes
 * out again; the screen is told whether one exists, which is all it needs to
 * draw the difference between "connect" and "replace".
 */
export function NotificationSettings() {
  const { data, loading, refresh } = useResource<Config>("/api/notifications");

  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<"test" | "chats" | null>(null);
  const [chats, setChats] = useState<Chat[] | null>(null);

  if (loading || !data) return <SkeletonBlock className="h-40" />;

  // Local edit wins until it is saved; otherwise show what the panel holds.
  const chatValue = chatId ?? data.chatId;

  async function save(patch: Record<string, unknown>, message: string) {
    setSaving(true);
    try {
      const res = await fetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? MSG.saveFailed);
        return false;
      }
      toast.success(message);
      refresh();
      return true;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function act(action: "test" | "chats") {
    setBusy(action);
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        chats?: Chat[];
      };

      if (action === "test") {
        if (body.ok) toast.success("Messaggio di prova inviato");
        else toast.error(body.error ?? "Invio non riuscito");
        return;
      }

      setChats(body.chats ?? []);
      if (body.error) toast.error(body.error);
      else if (body.chats?.length) toast.success(`${body.chats.length} chat trovate`);
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setBusy(null);
    }
  }

  function toggle(key: NotifyEventKey, on: boolean) {
    const next = on ? [...data!.events, key] : data!.events.filter((event) => event !== key);
    void save({ events: next }, on ? "Notifica attivata" : "Notifica disattivata");
  }

  return (
    <div className="space-y-5">
      {!data.configured && (
        <Hint tone="tip" title="Come si collega">
          Crea un bot con <strong className="text-foreground">@BotFather</strong> su Telegram,
          incolla qui il token che ti dà, poi scrivi un messaggio qualsiasi al tuo bot e premi
          Rileva. Il pannello parla solo in uscita: non serve che sia raggiungibile da internet.
        </Hint>
      )}

      <div>
        <TextField type="password" value={token} onChange={setToken}>
          <Label>Token del bot</Label>
          <Input
            placeholder={data.tokenSet ? "••••••••  (configurato)" : "123456789:AA…"}
            className="font-mono text-sm"
          />
        </TextField>
        <FieldHint>
          {data.tokenSet
            ? "Un token è già salvato, cifrato a riposo. Incollane un altro per sostituirlo."
            : "Viene salvato cifrato e non viene più restituito da questa pagina."}
        </FieldHint>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!token.trim() || saving}
            isPending={saving}
            onPress={async () => {
              // Verified against Telegram before it is stored, so a typo is
              // refused here rather than discovered by a silent notification.
              if (await save({ token: token.trim() }, "Bot collegato")) setToken("");
            }}
          >
            {data.tokenSet ? "Sostituisci il token" : "Collega il bot"}
          </Button>
          {data.tokenSet && (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={saving}
              onPress={() => void save({ token: "" }, "Bot scollegato")}
            >
              Scollega
            </Button>
          )}
        </div>
      </div>

      <div>
        <TextField value={chatValue} onChange={setChatId}>
          <Label>Chat di destinazione</Label>
          <Input placeholder="123456789" className="font-mono text-sm" />
        </TextField>
        <FieldHint>
          L&apos;id numerico della chat, negativo per i gruppi. Un bot non può scrivere per primo:
          mandagli un messaggio, poi premi Rileva.
        </FieldHint>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={chatValue === data.chatId || saving}
            isPending={saving}
            onPress={() => void save({ chatId: chatValue.trim() }, "Chat salvata")}
          >
            Salva la chat
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={!data.tokenSet || busy !== null}
            isPending={busy === "chats"}
            onPress={() => void act("chats")}
          >
            <Icon icon="solar:magnifer-linear" width={15} aria-hidden />
            Rileva
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={!data.configured || busy !== null}
            isPending={busy === "test"}
            onPress={() => void act("test")}
          >
            <Icon icon="solar:plain-linear" width={15} aria-hidden />
            Invia una prova
          </Button>
        </div>

        {chats !== null && chats.length > 0 && (
          <ul className="border-border divide-border mt-3 divide-y overflow-hidden rounded-[var(--radius)] border">
            {chats.map((chat) => (
              <li key={chat.id} className="flex items-center gap-3 px-3 py-2">
                <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                  {chat.title}
                  <span className="text-muted ml-2 text-xs">{chat.kind}</span>
                </span>
                <code className="text-muted shrink-0 font-mono text-xs">{chat.id}</code>
                <Button size="sm" variant="ghost" onPress={() => setChatId(chat.id)}>
                  Usa
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-4">
        <p className="text-muted text-sm font-medium">Cosa notificare</p>
        {NOTIFY_GROUPS.map((group) => (
          <div key={group.id} className="space-y-2.5">
            <p className="text-muted/60 text-meta tracking-wider uppercase">{group.label}</p>
            {group.events.map((event) => (
              <SettingToggle
                key={event.key}
                label={event.label}
                description={event.description}
                isSelected={data.events.includes(event.key)}
                isDisabled={saving}
                onChange={(on) => toggle(event.key, on)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
