import { NextRequest, NextResponse } from "next/server";
import { getSession, getAdminPasswordHash, verifyPassword, setAdminPassword, createSession, destroyAllSessions } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { z } from "zod";
import { getAllSettings, setSetting } from "@/lib/settings";
import { ACCENT_PRESETS, ACCENT_SETTING_KEY } from "@/lib/themes";

/**
 * Settings reported only as present or absent, never by value.
 *
 * Separate from the allowlist below because the client genuinely needs to know
 * whether a GitHub token is configured — it just must not learn what it is.
 */
const PRESENCE_ONLY_SETTINGS = new Set(["github_token"]);

/** Every preference a client is allowed to write, and what counts as valid. */
const preferencesSchema = z
  .object({
    polling_interval: z.enum(["2", "5", "10"]).optional(),
    timezone: z.string().max(64).optional(),
    [ACCENT_SETTING_KEY]: z
      .enum(ACCENT_PRESETS.map((p) => p.id) as [string, ...string[]])
      .optional(),
  })
  .strict();

/**
 * Everything `GET /api/settings` will hand back. The preferences a client
 * writes, plus the one key it needs to know the presence of.
 */
const READABLE_SETTINGS: readonly string[] = [
  "polling_interval",
  "timezone",
  ACCENT_SETTING_KEY,
  "github_token",
];

// GET: Read settings
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Non autorizzato" }, { status: 401 });

  const all = await getAllSettings();
  const settings: Record<string, string> = {};

  // An allowlist, not a list of things to hide.
  //
  // This used to return every row in the `settings` table and mask three known
  // names. That table is also where the autostart host config, the scheduler's
  // bookkeeping and the encrypted registry credentials live, and any secret
  // added to it later would have been published by default — the failure mode
  // of a denylist is silence.
  for (const key of READABLE_SETTINGS) {
    const value = all[key];
    if (value === undefined) continue;
    settings[key] = PRESENCE_ONLY_SETTINGS.has(key) ? (value ? "configured" : "") : value;
  }

  return NextResponse.json(settings, { headers: { "Cache-Control": "no-store" } });
}

// PUT: Update settings (password, preferences, or GitHub token)
export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Non autorizzato" }, { status: 401 });

  // A malformed body is a bad request, not a 500.
  // This handler reads a handful of optional fields by hand rather than through
  // one schema, because it serves three unrelated operations on one endpoint.
  // Each field is checked below; what matters here is that a body which is not
  // JSON at all becomes a 400 rather than an unhandled rejection.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const body = (raw ?? {}) as {
    currentPassword?: unknown;
    newPassword?: unknown;
    preferences?: unknown;
    github_token?: unknown;
  };

  // Password change
  if (typeof body.currentPassword === "string" && body.newPassword !== undefined) {
    if (typeof body.newPassword !== "string" || body.newPassword.length < 8) {
      return NextResponse.json(
        { error: "New password must be at least 8 characters" },
        { status: 400 }
      );
    }
    const hash = await getAdminPasswordHash();
    if (!hash) return NextResponse.json({ error: "No password set" }, { status: 400 });
    const valid = await verifyPassword(body.currentPassword, hash);
    if (!valid) {
      return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 });
    }
    await setAdminPassword(body.newPassword);

    // Changing the password ends every other device's session — that is the
    // usual reason for changing it. The current one is then re-issued so the
    // person doing it is not thrown out of the page they are on.
    await destroyAllSessions();
    await createSession({
      userAgent: request.headers.get("user-agent") ?? undefined,
      ip: request.headers.get("x-forwarded-for")?.split(",")[0].trim(),
    });

    return NextResponse.json({ success: true, signedOutOtherDevices: true });
  }

  // Preferences
  if (body.preferences) {
    const parsed = preferencesSchema.safeParse(body.preferences);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Preferenze non valide", details: parsed.error.issues },
        { status: 400 }
      );
    }

    // An allowlist rather than "any string that is not a secret": otherwise a
    // preferences payload can write arbitrary keys into the settings table.
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) await setSetting(key, value);
    }
    return NextResponse.json({ success: true });
  }

  // GitHub token
  if (body.github_token !== undefined) {
    const token = typeof body.github_token === "string" ? body.github_token.trim() : "";
    await setSetting("github_token", token ? encrypt(token) : "");
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
}
