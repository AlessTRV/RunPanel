import { Kysely } from "kysely";

/**
 * Say who is allowed to reach a published port.
 *
 * Every port RunPanel publishes today is published on every interface: the
 * provisioner writes `-p 5433:5432` and the app driver `-p 3000:3000`, both
 * without a bind address, so Docker binds `0.0.0.0` and — on Linux — installs
 * DNAT rules that sit in front of the host firewall. A database created from
 * the panel is reachable from every machine on the LAN, and from the internet
 * if the host has a public address. Nothing in the interface said so and
 * nothing could change it.
 *
 *   access_mode   'open' | 'restricted' — 'open' is exactly today's behaviour
 *   access_allow  JSON array of rules, e.g. ["192.168.1.0/24", "10.5.0.2"]
 *   access_port   the loopback port the real listener moved to while
 *                 restricted; NULL when open, because there is nothing in front
 *
 * Both tables, because it is the same question for a database and for an app,
 * and answering it in two shapes would give the operator two things to learn.
 */

const ACCESS_COLUMNS = [
  ["access_mode", "text"],
  ["access_allow", "text"],
  ["access_port", "integer"],
] as const;

type MigrationDb = Kysely<{
  projects: { access_mode: string | null; access_allow: string | null };
  services: { access_mode: string | null; access_allow: string | null };
}>;

export async function up(db: Kysely<unknown>): Promise<void> {
  // One statement per column: SQLite accepts a single ADD COLUMN per ALTER, so
  // chaining them would compile to valid Postgres and invalid SQLite.
  for (const table of ["projects", "services"] as const) {
    for (const [column, type] of ACCESS_COLUMNS) {
      await db.schema.alterTable(table).addColumn(column, type).execute();
    }
  }

  const typed = db as unknown as MigrationDb;

  /**
   * Everything starts open, which is what it already is.
   *
   * The temptation is to be helpful and restrict what looks local, and it would
   * be wrong twice over: the panel cannot know which of the machines currently
   * reaching a database is one the operator needs, and a restriction applied by
   * an upgrade fails as a timeout on somebody else's machine, at a distance no
   * one connects back to this release. A security default is worth having when
   * the operator chose it; imposed silently it is just an outage with a good
   * excuse.
   *
   * `[]` rather than NULL so a reader never has to decide what a missing list
   * means. Under `restricted` it reads as "only this machine", which is exactly
   * where a target lands the moment the switch goes on.
   */
  await typed.updateTable("projects").set({ access_mode: "open", access_allow: "[]" }).execute();
  await typed.updateTable("services").set({ access_mode: "open", access_allow: "[]" }).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ["projects", "services"] as const) {
    for (const [column] of [...ACCESS_COLUMNS].reverse()) {
      await db.schema.alterTable(table).dropColumn(column).execute();
    }
  }
}
