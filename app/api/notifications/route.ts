import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth-guard";
import { NOTIFY_EVENTS } from "@/lib/notify-events";
import { isConfigured, readConfig, sendTest, writeConfig } from "@/services/notify";
import { discoverChats, getMe } from "@/services/notify/telegram";

/**
 * The notification settings, and the two buttons next to them.
 *
 * Three verbs on one route rather than four routes, the way
 * `app/api/autostart/host/route.ts` already does it: reading the configuration,
 * writing it, and the two actions that only make sense against the
 * configuration that was just written.
 *
 * The token is never handed back. It is stored encrypted like the GitHub one,
 * and the screen only ever needs to know whether there *is* one — the same
 * distinction `PRESENCE_ONLY_SETTINGS` draws in the settings route.
 */

/**
 * `123456789:AA...`, which is the shape BotFather issues.
 *
 * Checked because the alternative is a save that succeeds, a test that fails
 * with "Unauthorized", and no way to tell a mistyped token from a revoked one.
 */
const TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;

/**
 * A numeric id, negative for groups and supergroups, or an `@channelname`.
 *
 * Interpolated into an API call rather than a path, so this is about telling
 * somebody they have pasted the wrong thing — a username instead of an id is
 * the usual mistake, and it fails with "chat not found" hours later.
 */
const CHAT_PATTERN = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

const putSchema = z
  .object({
    /** An empty string disconnects the bot. Absent leaves it alone. */
    token: z.union([z.string().regex(TOKEN_PATTERN, "Token del bot non valido"), z.literal("")]).optional(),
    chatId: z.union([z.string().regex(CHAT_PATTERN, "Chat non valida"), z.literal("")]).optional(),
    events: z.array(z.enum(NOTIFY_EVENTS)).optional(),
  })
  .strict();

const postSchema = z.object({ action: z.enum(["test", "chats"]) }).strict();

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const config = await readConfig();

  return NextResponse.json(
    {
      tokenSet: Boolean(config.token),
      chatId: config.chatId ?? "",
      events: config.events,
      configured: isConfigured(config),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function PUT(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const parsed = putSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { token, chatId, events } = parsed.data;

  // Checked before it is stored, so a typo is refused while the operator is
  // still looking at the field rather than discovered by a silent notification
  // three days later.
  if (token) {
    const identity = await getMe(token);
    if (!identity.ok) {
      return NextResponse.json({ error: identity.error ?? "Token rifiutato da Telegram" }, { status: 400 });
    }
  }

  await writeConfig({
    ...(token !== undefined ? { token: token || null } : {}),
    ...(chatId !== undefined ? { chatId: chatId || null } : {}),
    ...(events !== undefined ? { events } : {}),
  });

  const config = await readConfig();
  return NextResponse.json({ success: true, configured: isConfigured(config) });
}

export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Azione non valida" }, { status: 400 });
  }

  if (parsed.data.action === "test") {
    const result = await sendTest();
    // 200 with the reason inside, not a 500: "chat not found" is a successful
    // question with an answer the operator has to act on.
    return NextResponse.json(result);
  }

  const config = await readConfig();
  if (!config.token) {
    return NextResponse.json({ ok: false, error: "Salva prima il token del bot." });
  }

  const found = await discoverChats(config.token);
  if (!found.ok) return NextResponse.json({ ok: false, error: found.error });

  return NextResponse.json({
    ok: true,
    chats: found.chats,
    ...(found.chats && found.chats.length === 0
      ? {
          error:
            "Nessuna chat trovata. Apri Telegram, scrivi un messaggio qualsiasi al bot e riprova: finché non gli scrivi tu, un bot non sa dove mandarti niente.",
        }
      : {}),
  });
}
