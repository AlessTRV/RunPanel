/**
 * The handful of places where SQLite and Postgres disagree, in one file.
 *
 * The rule everywhere else in the codebase: never write a dialect-specific
 * default or function into a query. Generate the value here instead.
 */

/** The single timestamp format used by every column in the schema. */
export function nowIso(): string {
  return new Date().toISOString();
}



/**
 * Kysely reports affected-row counts as `bigint`. Callers only ever want to know
 * "how many" for a log line or an `if`, so narrow it once here.
 */
export function rowCount(result: { numUpdatedRows?: bigint; numDeletedRows?: bigint } | undefined): number {
  if (!result) return 0;
  const raw = result.numUpdatedRows ?? result.numDeletedRows;
  return raw === undefined ? 0 : Number(raw);
}
