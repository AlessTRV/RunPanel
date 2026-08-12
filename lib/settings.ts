import { getDb } from "./db";

/**
 * The `settings` table is RunPanel's key/value store for singletons: the admin
 * password hash, the session, the GitHub token, UI preferences. Every read and
 * write goes through here so the upsert is written once and stays portable
 * across both dialects.
 */

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("settings")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  return row?.value ?? null;
}

export async function getSettings(keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const db = await getDb();
  const rows = await db
    .selectFrom("settings")
    .select(["key", "value"])
    .where("key", "in", keys)
    .execute();

  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = await db.selectFrom("settings").select(["key", "value"]).execute();
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db
    .insertInto("settings")
    .values({ key, value })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
    .execute();
}

/**
 * Write a key only if nobody has written it yet. Returns whether this call was
 * the one that did.
 *
 * The claim and the check are one statement so two callers racing for the same
 * key cannot both win — `setSetting` would let the second one overwrite the
 * first. First-run setup depends on that: the admin password is claimed once.
 */
export async function setSettingIfAbsent(key: string, value: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .insertInto("settings")
    .values({ key, value })
    .onConflict((oc) => oc.column("key").doNothing())
    .returning("key")
    .executeTakeFirst();
  return row !== undefined;
}

export async function deleteSettings(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await getDb();
  await db.deleteFrom("settings").where("key", "in", keys).execute();
}
