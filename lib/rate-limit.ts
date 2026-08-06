import { getDb, nowIso } from "./db";

/**
 * A rate limiter that survives a restart.
 *
 * The login limiter used to be a module-level Map: restarting the server —
 * something an operator does routinely on a panel like this — reset every
 * counter and handed whoever was guessing a fresh set of attempts. Persisting
 * it also means the limit still holds if the panel ever runs more than one
 * process.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const db = await getDb();
  const now = Date.now();

  const existing = await db
    .selectFrom("rate_limits")
    .selectAll()
    .where("key", "=", key)
    .executeTakeFirst();

  const expired = !existing || new Date(existing.reset_at).getTime() <= now;

  if (expired) {
    const resetAt = new Date(now + windowMs).toISOString();
    await db
      .insertInto("rate_limits")
      .values({ key, count: 1, reset_at: resetAt })
      .onConflict((oc) => oc.column("key").doUpdateSet({ count: 1, reset_at: resetAt }))
      .execute();
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }

  const count = existing.count + 1;
  await db.updateTable("rate_limits").set({ count }).where("key", "=", key).execute();

  const retryAfter = Math.max(0, Math.ceil((new Date(existing.reset_at).getTime() - now) / 1000));
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfter };
}

/** Called after a success, so a legitimate user is not punished for typos. */
export async function clearRateLimit(key: string): Promise<void> {
  const db = await getDb();
  await db.deleteFrom("rate_limits").where("key", "=", key).execute();
}

/** Drop windows that have already elapsed. */
export async function pruneRateLimits(): Promise<void> {
  const db = await getDb();
  await db.deleteFrom("rate_limits").where("reset_at", "<", nowIso()).execute();
}
