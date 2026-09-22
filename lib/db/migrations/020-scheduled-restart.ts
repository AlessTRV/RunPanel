import { Kysely } from "kysely";

/**
 * A restart on a schedule, per project and per service.
 *
 * Five columns on each table, the same five, because the scheduler treats the
 * two the same way:
 *
 *  - `restart_cron`: the expression as typed, empty = no schedule. The same
 *    parser as backup policies; the panel's `timezone` setting decides the
 *    zone, so there is no column for one here.
 *  - `restart_next_at`: the next due instant, and the scheduler's claim token
 *    — moved forward by a conditional UPDATE, exactly like `backup_policies`.
 *  - `restart_last_at` / `restart_last_result`: when the schedule last fired
 *    and what it did, so the page can say "Riavviato" or "Saltato: fermato a
 *    mano" instead of leaving the operator to guess.
 *  - `crashed_at`: set by the status sweep when it writes `stopped` on a row
 *    nobody asked to stop, cleared by every start, stop and deploy. It is what
 *    lets the schedule tell a crash from a decision: a target stopped on
 *    purpose is skipped, a crashed one gets a single attempt.
 *
 * One statement per column: SQLite accepts a single ADD COLUMN per ALTER.
 */
const TABLES = ["projects", "services"] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await db.schema
      .alterTable(table)
      .addColumn("restart_cron", "text", (col) => col.notNull().defaultTo(""))
      .execute();
    await db.schema.alterTable(table).addColumn("restart_next_at", "text").execute();
    await db.schema.alterTable(table).addColumn("restart_last_at", "text").execute();
    await db.schema.alterTable(table).addColumn("restart_last_result", "text").execute();
    await db.schema.alterTable(table).addColumn("crashed_at", "text").execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    for (const column of ["crashed_at", "restart_last_result", "restart_last_at", "restart_next_at", "restart_cron"]) {
      await db.schema.alterTable(table).dropColumn(column).execute();
    }
  }
}
