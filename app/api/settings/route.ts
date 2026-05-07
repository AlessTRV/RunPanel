import { NextRequest, NextResponse } from "next/server";
import { getSession, getAdminPasswordHash, verifyPassword, setAdminPassword } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/auth";

// GET: Read settings
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const row of rows) {
    // Decrypt sensitive values
    if (row.key === "github_token" && row.value) {
      try { settings[row.key] = decrypt(row.value) ? "configured" : ""; } catch { settings[row.key] = ""; }
    } else {
      settings[row.key] = row.value;
    }
  }
  return NextResponse.json(settings);
}

// PUT: Update settings (password or preferences)
export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  // Password change
  if (body.currentPassword && body.newPassword) {
    if (body.newPassword.length < 8) {
      return NextResponse.json({ error: "New password must be at least 8 characters" }, { status: 400 });
    }
    const hash = getAdminPasswordHash();
    if (!hash) return NextResponse.json({ error: "No password set" }, { status: 400 });
    const valid = await verifyPassword(body.currentPassword, hash);
    if (!valid) return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 });
    await setAdminPassword(body.newPassword);
    return NextResponse.json({ success: true });
  }

  // Preferences
  if (body.preferences) {
    const db = getDb();
    const upsert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?");
    for (const [key, value] of Object.entries(body.preferences)) {
      if (typeof value === "string") {
        upsert.run(key, value, value);
      }
    }
    return NextResponse.json({ success: true });
  }

  // GitHub token
  if (body.github_token !== undefined) {
    const db = getDb();
    const encrypted = body.github_token ? encrypt(body.github_token) : "";
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_token', ?) ON CONFLICT(key) DO UPDATE SET value = ?")
      .run(encrypted, encrypted);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}
