/**
 * Next calls `register()` once per server process, before the first request.
 *
 * Validating the environment here means a misconfigured deployment fails loudly
 * at boot with a list of what is wrong, instead of returning a 500 on whichever
 * request first happens to touch the database.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getEnv } = await import("./lib/env");
  const env = getEnv();

  console.log(
    `[RunPanel] Booting — data dir ${env.dataDir}, store ${env.db.driver}`
  );

  // Opening the store here also applies migrations and crash recovery up front,
  // so the first real request does not pay for it.
  const { getDb } = await import("./lib/db");
  await getDb();
}
