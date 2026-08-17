import { Kysely } from "kysely";

/**
 * A service whose data lives where the operator put it.
 *
 * Until now a service wrote into a named Docker volume whose name the panel
 * derived, and there was no way to say "not there" — not onto the larger disk,
 * not onto the array, not anywhere the host had room. The provisioner already
 * passed an absolute source straight through to `docker run -v` and kept it out
 * of everything it deletes; what was missing was somewhere to record the choice
 * and something to move the bytes.
 *
 *   data_path   the host directory this service is bound to. NULL means the
 *               named volume the template derives, which is where every
 *               existing service is.
 *   data_move   JSON journal of the move in flight, or of the last one that
 *               finished. NULL means there is nothing to say.
 *
 * Two columns rather than a corner of `config`, which the schema describes as
 * holding "template-specific fields" but which has been written exactly once,
 * as `{}`, since migration 004. The deciding reason is restart recovery: a
 * panel that died mid-move has to find that service again, and
 * `where data_move is not null` is one indexed query on both dialects, where
 * the same question against a JSON blob is a scan and a parse per row.
 *
 * `data_path` is a *declaration*. Docker is the authority on where a container
 * is actually mounted, and the recovery pass asks it rather than this column —
 * see `reconcileDataMoves` in services/service-data-move.ts.
 */
const DATA_COLUMNS = [
  ["data_path", "text"],
  ["data_move", "text"],
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  // One statement per column: SQLite accepts a single ADD COLUMN per ALTER, so
  // chaining them would compile to valid Postgres and invalid SQLite.
  for (const [column, type] of DATA_COLUMNS) {
    await db.schema.alterTable("services").addColumn(column, type).execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [column] of [...DATA_COLUMNS].reverse()) {
    await db.schema.alterTable("services").dropColumn(column).execute();
  }
}
