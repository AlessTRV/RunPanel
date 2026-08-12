import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { buildDestination } from "@/services/backup/destinations";

type Params = { params: Promise<{ destinationId: string }> };

/**
 * Check a destination before the night it matters.
 *
 * The check writes a real file rather than looking at the directory: a
 * read-only mount and a full disk both look perfectly fine until something
 * actually tries to write.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { destinationId } = await params;
  const db = await getDb();
  const row = await db
    .selectFrom("backup_destinations")
    .selectAll()
    .where("id", "=", destinationId)
    .executeTakeFirst();

  if (!row) return NextResponse.json({ error: "Destinazione non trovata" }, { status: 404 });

  try {
    return NextResponse.json(await buildDestination(row).test());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verifica fallita";
    return NextResponse.json({ ok: false, message });
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { destinationId } = await params;
  const db = await getDb();

  // Deleting it would cascade every policy pointing at it, which is a
  // surprising amount of configuration to lose to one click.
  const used = await db
    .selectFrom("backup_policies")
    .select("name")
    .where("destination_id", "=", destinationId)
    .execute();

  if (used.length > 0) {
    return NextResponse.json(
      {
        error: `Usata da ${used.length} pianificazion${used.length === 1 ? "e" : "i"}: ${used
          .map((policy) => policy.name)
          .join(", ")}`,
      },
      { status: 409 }
    );
  }

  await db.deleteFrom("backup_destinations").where("id", "=", destinationId).execute();
  return NextResponse.json({ ok: true });
}
