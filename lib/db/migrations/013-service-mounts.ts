import { Kysely } from "kysely";

/**
 * Bind mounts on a service, replacing the data-path move of migration 012.
 *
 * 012 let a service's data *directory* be relocated to a host path, with a copy
 * and a verification pass around it. That was the wrong shape: what an operator
 * wants is not a removal van, it is a **list** — this container folder appears
 * at that folder on the host, and that one over there too, and I can turn each
 * of them off.
 *
 * So the two columns go and one takes their place. They are dropped rather than
 * left dead because 012 is already applied on real installations, and a column
 * nothing reads is a column the next person has to work out the meaning of.
 *
 *   mounts        JSON array of `ServiceMount` — see services/service-mounts.ts.
 *                 NULL and `[]` both mean "only the volume the template declares".
 *   mount_apply   JSON journal of the application in flight, or of the last one
 *                 that finished. NULL when there is nothing to say.
 *
 * The careful half of 012 is not lost: relocating a database is now a bind whose
 * target happens to be the engine's data directory, and that case still stops
 * the service, copies with ownership intact, verifies the databases came back
 * and rolls itself back if they did not.
 */
const ADDED = ["mounts", "mount_apply"] as const;
const DROPPED = ["data_move", "data_path"] as const;

/**
 * Where each engine kept its data when this migration was written.
 *
 * Frozen on purpose, and deliberately **not** imported from
 * `lib/service-versions.ts`. A migration is a statement about the past: a value
 * that followed the code would rewrite history the day PostgreSQL 19 moves
 * `PGDATA` again, and the row it converted would name a directory that was
 * never the one in use.
 */
const DATA_TARGET: Record<string, (version: string) => string> = {
  postgresql: (version) =>
    Number.parseInt(version, 10) >= 18 ? "/var/lib/postgresql" : "/var/lib/postgresql/data",
  mysql: () => "/var/lib/mysql",
  redis: () => "/data",
  mongodb: () => "/data/db",
};

interface LegacyRow {
  id: string;
  type: string;
  version: string;
  data_path: string | null;
  mounts: string | null;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // One statement per column: SQLite accepts a single ADD/DROP COLUMN per
  // ALTER, so chaining them would compile to valid Postgres and invalid SQLite.
  for (const column of ADDED) {
    await db.schema.alterTable("services").addColumn(column, "text").execute();
  }

  /*
    Carry the declaration over BEFORE dropping it.

    A service whose data was moved to a host directory, and whose column is
    simply dropped, comes back on the template's named volume the next time
    anything recreates its container — changing the access restriction is
    enough. On PostgreSQL 18 that is the trap `postgresVolumePath` documents:
    it initialises on the empty volume, works perfectly, and the real data sits
    somewhere nobody is looking.
  */
  const typed = db as Kysely<{ services: LegacyRow }>;
  const moved = await typed
    .selectFrom("services")
    .select(["id", "type", "version", "data_path"])
    .where("data_path", "is not", null)
    .execute();

  for (const row of moved) {
    const target = DATA_TARGET[row.type]?.(row.version);
    if (!target || !row.data_path) continue;

    await typed
      .updateTable("services")
      .set({
        mounts: JSON.stringify([
          { id: `legacy-${row.id}`, source: row.data_path, target, enabled: true, readOnly: false },
        ]),
      })
      .where("id", "=", row.id)
      .execute();
  }

  for (const column of DROPPED) {
    await db.schema.alterTable("services").dropColumn(column).execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const column of [...DROPPED].reverse()) {
    await db.schema.alterTable("services").addColumn(column, "text").execute();
  }
  for (const column of [...ADDED].reverse()) {
    await db.schema.alterTable("services").dropColumn(column).execute();
  }
}
