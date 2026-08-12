import { NextRequest, NextResponse } from "next/server";
import { encrypt } from "@/lib/crypto";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { destinationSchema } from "@/lib/validation";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const db = await getDb();
  const rows = await db
    .selectFrom("backup_destinations")
    .select(["id", "name", "type", "is_default", "created_at"])
    .orderBy("created_at", "asc")
    .execute();

  // The config is never returned: it is ciphertext, and for anything other than
  // `local` it will hold a token.
  return NextResponse.json({
    destinations: rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      isDefault: row.is_default === 1,
      createdAt: row.created_at,
    })),
  });
}

export async function POST(request: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  // A malformed body is a bad request, not a 500.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }

  const parsed = destinationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { name, type, config, isDefault } = parsed.data;
  const db = await getDb();

  const clash = await db
    .selectFrom("backup_destinations")
    .select("id")
    .where("name", "=", name)
    .executeTakeFirst();

  if (clash) {
    return NextResponse.json(
      { error: `Esiste già una destinazione chiamata "${name}"` },
      { status: 409 }
    );
  }

  const id = generateId();
  const now = nowIso();

  if (isDefault) {
    await db.updateTable("backup_destinations").set({ is_default: 0 }).execute();
  }

  await db
    .insertInto("backup_destinations")
    .values({
      id,
      name,
      type,
      config: encrypt(JSON.stringify(config ?? {})),
      is_default: isDefault ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
    .execute();

  return NextResponse.json({ id, name, type, isDefault: Boolean(isDefault) }, { status: 201 });
}
