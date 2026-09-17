import type { Kysely } from "kysely";
import type { Database } from "@/lib/db";

/**
 * The two rules every folder write shares, kept in one place so the folder
 * routes and the two PATCH handlers that file things cannot drift.
 */

/**
 * Another folder already carrying this name, ignoring case and padding.
 *
 * Compared through `lower()` rather than a unique index on the column: an
 * index would let "Clienti" and "clienti" coexist, and two folders that read
 * as the same one is the confusion the check exists to prevent.
 */
export async function findFolderByName(
  db: Kysely<Database>,
  name: string,
  exceptId?: string
): Promise<{ id: string } | undefined> {
  let query = db
    .selectFrom("folders")
    .select("id")
    .where((eb) => eb(eb.fn("lower", ["name"]), "=", name.trim().toLowerCase()));
  if (exceptId) query = query.where("id", "!=", exceptId);
  return query.executeTakeFirst();
}

/**
 * Whether `folderId` names a folder. `null` — the root — always does.
 *
 * Asked before a project or service is filed there, because SQLite enforces
 * the foreign key only with the pragma on and Postgres reports the violation
 * as a 500: a move to a folder that is not there is a 404, not a crash.
 */
export async function folderExists(db: Kysely<Database>, folderId: string | null): Promise<boolean> {
  if (folderId === null) return true;
  const row = await db.selectFrom("folders").select("id").where("id", "=", folderId).executeTakeFirst();
  return row !== undefined;
}
