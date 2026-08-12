import { Kysely, sql } from "kysely";
import { tryDecrypt } from "@/lib/crypto";

/**
 * Turn "a database is attached to this project" into something the operator can
 * steer.
 *
 * Attaching a service made the panel inject its connection URL into the app's
 * environment, and the only way to stop it was to define a variable with the
 * same name yourself. Nothing said so where you could see it, the check was on
 * the VALUE being truthy rather than the key existing — so a variable saved
 * empty was silently overwritten while the UI claimed the opposite — and two
 * databases of the same type both resolved to `DATABASE_URL`, where whichever
 * the loop reached first won and the second logged "not linked" into a build
 * log nobody reads.
 *
 * Two columns replace all of that with a switch and a name.
 *
 *   inject_env   0 | 1 — whether this link contributes a variable at all
 *   env_key      the variable it contributes; NULL means "derive it from the
 *                service type", which is the old behaviour and the right
 *                default for the overwhelmingly common single-database project
 */

type MigrationDb = Kysely<{
  services: {
    id: string;
    type: string;
    project_id: string | null;
    inject_env: number | null;
    env_key: string | null;
  };
  env_vars: {
    project_id: string;
    key: string;
    value: string;
  };
}>;

/** Mirrors `connectionEnvKey` in `lib/service-env.ts`. */
function defaultEnvKey(type: string): string {
  if (type === "redis") return "REDIS_URL";
  if (type === "mongodb") return "MONGODB_URL";
  return "DATABASE_URL";
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // One statement per column: SQLite accepts a single ADD COLUMN per ALTER, so
  // chaining them would compile to valid Postgres and invalid SQLite.
  await db.schema.alterTable("services").addColumn("inject_env", "integer").execute();
  await db.schema.alterTable("services").addColumn("env_key", "text").execute();

  const typed = db as unknown as MigrationDb;

  // Standalone services inject nothing — there is no project to inject into.
  await typed.updateTable("services").set({ inject_env: 0 }).where("project_id", "is", null).execute();

  const linked = await typed
    .selectFrom("services")
    .select(["id", "type", "project_id"])
    .where("project_id", "is not", null)
    .execute();

  if (linked.length === 0) return;

  /**
   * The backfill has to leave every existing deployment doing exactly what it
   * did before, because the first deploy after an upgrade is the worst possible
   * moment to discover that an app changed database.
   *
   * The old rule was `if (!envVars[key])` — inject unless the project's own
   * decrypted value is truthy. So: a project that had set that variable to
   * something non-empty was NOT receiving the service URL, and its link starts
   * OFF. Everything else starts ON.
   *
   * This is why the value is decrypted rather than tested in SQL: a variable
   * saved empty encrypts to a perfectly non-empty ciphertext, and reading the
   * column would invert the answer for precisely the case that motivated the
   * change.
   */
  for (const service of linked) {
    const key = defaultEnvKey(service.type);

    const existing = await typed
      .selectFrom("env_vars")
      .select("value")
      .where("project_id", "=", service.project_id as string)
      .where("key", "=", key)
      .executeTakeFirst();

    // Undecryptable ciphertext (a restored archive, a rotated secret) is
    // treated as "the user set something": leaving injection off is the
    // reversible mistake, silently replacing a connection string is not.
    const plain = existing === undefined ? null : tryDecrypt(existing.value);
    const overrides = existing !== undefined && (plain === null || plain !== "");

    await typed
      .updateTable("services")
      .set({ inject_env: overrides ? 0 : 1 })
      .where("id", "=", service.id)
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // SQLite gained DROP COLUMN in 3.35, the same release this project already
  // requires for `ON CONFLICT ... RETURNING` in the rate limiter.
  await sql`alter table services drop column env_key`.execute(db);
  await sql`alter table services drop column inject_env`.execute(db);
}
