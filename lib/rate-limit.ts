import { sql } from "kysely";
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
  const nowStamp = new Date(now).toISOString();
  const freshReset = new Date(now + windowMs).toISOString();

  /**
   * One statement, deliberately.
   *
   * This was a SELECT followed by an UPDATE that wrote `existing.count + 1` as
   * an absolute value. Concurrent attempts all read the same count and all
   * wrote the same number back, so twenty parallel requests advanced the
   * counter by one and the limit only ever applied to attempts made one after
   * another. The increment has to happen inside the database.
   *
   * The CASE arms roll the window over in place: an expired row starts again at
   * 1 with a fresh deadline, a live one counts up and keeps its own. Both
   * dialects read `rate_limits.<col>` in a DO UPDATE as the row already there.
   */
  const row = await db
    .insertInto("rate_limits")
    .values({ key, count: 1, reset_at: freshReset })
    .onConflict((oc) =>
      oc.column("key").doUpdateSet({
        count: sql<number>`case when rate_limits.reset_at <= ${nowStamp} then 1 else rate_limits.count + 1 end`,
        reset_at: sql<string>`case when rate_limits.reset_at <= ${nowStamp} then ${freshReset} else rate_limits.reset_at end`,
      })
    )
    .returning(["count", "reset_at"])
    .executeTakeFirst();

  // The upsert always returns a row. If that ever stops being true, refuse
  // rather than hand out an unlimited allowance.
  if (!row) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil(windowMs / 1000) };
  }

  const count = Number(row.count);
  const retryAfter = Math.max(0, Math.ceil((new Date(row.reset_at).getTime() - now) / 1000));

  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfter };
}

/** Called after a success, so a legitimate user is not punished for typos. */
export async function clearRateLimit(key: string): Promise<void> {
  const db = await getDb();
  await db.deleteFrom("rate_limits").where("key", "=", key).execute();
}

/**
 * Drop windows that have already elapsed.
 *
 * Not housekeeping for its own sake: the key of the login limiter contains a
 * client address, so every distinct one leaves a row behind. Without this the
 * table is an unauthenticated write that nothing ever collects.
 */
export async function pruneRateLimits(): Promise<number> {
  const db = await getDb();
  const result = await db.deleteFrom("rate_limits").where("reset_at", "<", nowIso()).executeTakeFirst();
  return Number(result?.numDeletedRows ?? 0);
}
