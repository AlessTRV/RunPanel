import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireFolder } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { deleteGrantsFor } from "@/lib/users";
import { getDb, nowIso } from "@/lib/db";
import { updateFolderSchema } from "@/lib/validation";
import { findFolderByName } from "@/services/folders";

type Params = { params: Promise<{ folderId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "folder.update", scope: "folder", scopeId: async () => (await params).folderId }, async () => {
    const { folderId } = await params;
    const denied = await requireFolder(folderId);
    if (isDenied(denied)) return denied;

    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = updateFolderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const db = await getDb();
    const folder = await db.selectFrom("folders").selectAll().where("id", "=", folderId).executeTakeFirst();
    if (!folder) {
      return NextResponse.json({ error: "Cartella non trovata" }, { status: 404 });
    }

    const { name } = parsed.data;
    if (await findFolderByName(db, name, folderId)) {
      return NextResponse.json({ error: `Esiste già una cartella "${name}".` }, { status: 409 });
    }

    const updated_at = nowIso();
    await db.updateTable("folders").set({ name, updated_at }).where("id", "=", folderId).execute();

    return NextResponse.json({ ...folder, name, updated_at });
  });
}

/**
 * Deleting a folder empties it onto the root; it never takes a project or a
 * service with it. The columns are cleared here in the same transaction as
 * the delete rather than left to `on delete set null`, so the outcome does not
 * depend on which dialect — or which SQLite pragma — is underneath.
 */
export async function DELETE(_request: NextRequest, { params }: Params) {
  return withAudit(_request, { category: "delete", action: "folder.delete", scope: "folder", scopeId: async () => (await params).folderId }, async () => {
    const { folderId } = await params;
    const denied = await requireFolder(folderId);
    if (isDenied(denied)) return denied;
    const db = await getDb();

    const folder = await db.selectFrom("folders").select("id").where("id", "=", folderId).executeTakeFirst();
    if (!folder) {
      return NextResponse.json({ error: "Cartella non trovata" }, { status: 404 });
    }

    const now = nowIso();
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("projects")
        .set({ folder_id: null, updated_at: now })
        .where("folder_id", "=", folderId)
        .execute();
      await trx
        .updateTable("services")
        .set({ folder_id: null, updated_at: now })
        .where("folder_id", "=", folderId)
        .execute();
      await trx.deleteFrom("folders").where("id", "=", folderId).execute();
    });
    await deleteGrantsFor("folder", folderId);

    return NextResponse.json({ success: true });
  });
}
