import { decrypt, encrypt } from "@/lib/auth";
import { getDb, nowIso } from "@/lib/db";
import type { BackupDestinationsTable } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { localDestination } from "./local";
import type { Destination } from "../types";

/**
 * Which transports exist, and how a stored row becomes one.
 *
 * Only `local` is implemented. The row's `config` is encrypted anyway, from the
 * very first migration: a column that is sometimes ciphertext and sometimes not
 * is a column nobody can reason about, and the day a bot token needs storing it
 * should not also be the day the storage format changes.
 */

type Factory = (row: BackupDestinationsTable, config: Record<string, unknown>) => Destination;

const FACTORIES: Record<string, Factory> = {
  local: (row) => localDestination(row),
};

export function destinationConfig(row: BackupDestinationsTable): Record<string, unknown> {
  try {
    return JSON.parse(decrypt(row.config)) as Record<string, unknown>;
  } catch {
    // An unreadable config is not a reason to lose the destination: local needs
    // none, and anything else will fail loudly on its first call.
    return {};
  }
}

export function buildDestination(row: BackupDestinationsTable): Destination {
  const factory = FACTORIES[row.type];
  if (!factory) throw new Error(`Destinazione di tipo "${row.type}" non supportata`);
  return factory(row, destinationConfig(row));
}

export async function loadDestination(id: string): Promise<Destination> {
  const db = await getDb();
  const row = await db
    .selectFrom("backup_destinations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!row) throw new Error("Destinazione non trovata");
  return buildDestination(row);
}

export async function defaultDestinationId(): Promise<string | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("backup_destinations")
    .select("id")
    .orderBy("is_default", "desc")
    .orderBy("created_at", "asc")
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Create the local destination on first boot.
 *
 * Deliberately here and not in migration 005: a migration that called
 * `encrypt()` would tie the schema to `getSecret()`, and a schema that cannot be
 * applied without a working key is a schema that fails in the one situation
 * where you most need it to apply.
 */
export async function ensureDefaultDestination(): Promise<void> {
  const db = await getDb();
  const existing = await db
    .selectFrom("backup_destinations")
    .select("id")
    .limit(1)
    .executeTakeFirst();
  if (existing) return;

  const now = nowIso();
  await db
    .insertInto("backup_destinations")
    .values({
      id: generateId(),
      name: "Disco locale",
      type: "local",
      config: encrypt("{}"),
      is_default: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
}
