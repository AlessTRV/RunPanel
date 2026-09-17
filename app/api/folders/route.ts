import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb, nowIso } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { createFolderSchema } from "@/lib/validation";
import { findFolderByName } from "@/services/folders";

/**
 * Folders for the Overview: flat, named, and nothing else. What each one holds
 * is not answered here — the projects and services lists carry `folder_id`,
 * and the page groups them itself, so one folder list serves every poll.
 */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  const db = await getDb();
  const folders = await db.selectFrom("folders").selectAll().orderBy("name", "asc").execute();
  return NextResponse.json(folders);
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
  const parsed = createFolderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dati non validi", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { name } = parsed.data;
  const db = await getDb();

  if (await findFolderByName(db, name)) {
    return NextResponse.json({ error: `Esiste già una cartella "${name}".` }, { status: 409 });
  }

  const now = nowIso();
  const folder = { id: generateId(), name, created_at: now, updated_at: now };
  await db.insertInto("folders").values(folder).execute();

  return NextResponse.json(folder, { status: 201 });
}
