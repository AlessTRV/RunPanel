import { docker, dockerTry, lines } from "./docker/cli";
import { decrypt } from "@/lib/auth";
import type { ServicesTable } from "@/lib/db/schema";

/**
 * The logical databases inside one service.
 *
 * A service is a database *server*: one Postgres container holds `app`,
 * `staging` and `analytics` at once, each with its own connection URL, and
 * provisioning a second container for each of them wastes a gigabyte of RAM to
 * express something the engine already models.
 *
 * Everything here goes through `docker exec` with an argv array — never a shell
 * string — so there is no shell to inject into. What remains is SQL: an
 * identifier cannot be parameterised in `CREATE DATABASE`, so the name is
 * interpolated, and `databaseNameSchema` in `lib/validation.ts` is the whole
 * defence. Nothing in this module may be called with a name that has not been
 * through it.
 *
 * On the password reaching the engine: it travels as `docker exec -e`, which
 * puts it on the docker client's argv and so in the host's process list. That
 * is not a new exposure — anyone who can read that list can also run
 * `docker inspect` and read `POSTGRES_PASSWORD` out of the container's own
 * environment. It is preferred to `-p<password>` because the MySQL client
 * writes a warning to stderr for that form, which would end up parsed as data.
 */

export interface ServiceTarget {
  containerName: string;
  credentials: { user: string; password: string; database: string };
}

export interface DatabaseAdmin {
  /** False where the engine has no named databases to manage. */
  supported: boolean;
  /** Names the engine owns. Listed, never offered for deletion. */
  system: readonly string[];
  list(target: ServiceTarget): Promise<string[]>;
  create(target: ServiceTarget, name: string): Promise<void>;
  drop(target: ServiceTarget, name: string): Promise<void>;
}

/** Raised where the engine's refusal is a state the operator can resolve. */
export class DatabaseBusyError extends Error {
  constructor(name: string) {
    super(`Il database "${name}" ha connessioni aperte.`);
    this.name = "DatabaseBusyError";
  }
}

const EXEC_TIMEOUT = 30_000;

const unsupported: DatabaseAdmin = {
  supported: false,
  system: [],
  async list() {
    return [];
  },
  async create() {
    throw new Error("Questo tipo di servizio non ha database con un nome.");
  },
  async drop() {
    throw new Error("Questo tipo di servizio non ha database con un nome.");
  },
};

const postgresqlAdmin: DatabaseAdmin = {
  supported: true,
  // template0/template1 are the prototypes every new database is copied from;
  // `postgres` is the maintenance database this module connects through.
  system: ["postgres", "template0", "template1"],

  async list(target) {
    const result = await dockerTry(
      [
        ...execArgs(target, { PGPASSWORD: target.credentials.password }),
        "psql", "-U", target.credentials.user, "-d", "postgres", "-Atc",
        "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname",
      ],
      { timeout: EXEC_TIMEOUT }
    );
    return result ? lines(result.stdout) : [];
  },

  async create(target, name) {
    await psql(target, `CREATE DATABASE "${name}"`);
  },

  async drop(target, name) {
    try {
      // Always issued through `postgres`, never through the database being
      // dropped — the official image always creates it, even when POSTGRES_DB
      // names something else, and an engine refuses to drop the database its
      // own session is attached to.
      await psql(target, `DROP DATABASE "${name}"`);
    } catch (err) {
      // Deliberately not `WITH (FORCE)`: that terminates live sessions, which
      // is a second destructive act hidden inside the one that was confirmed.
      if (/is being accessed by other users/i.test(String(err))) {
        throw new DatabaseBusyError(name);
      }
      throw err;
    }
  },
};

const mysqlAdmin: DatabaseAdmin = {
  supported: true,
  system: ["information_schema", "mysql", "performance_schema", "sys"],

  async list(target) {
    const result = await dockerTry(
      [
        ...execArgs(target, { MYSQL_PWD: target.credentials.password }),
        "mysql", "-u", "root", "-N", "-B", "-e", "SHOW DATABASES",
      ],
      { timeout: EXEC_TIMEOUT }
    );
    return result ? lines(result.stdout) : [];
  },

  async create(target, name) {
    // utf8mb4 explicitly: MySQL 5.7 still defaults to latin1, and a database
    // that cannot store an emoji is discovered much later than it is created.
    await mysqlExec(
      target,
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );

    // The service's URL uses MYSQL_USER, not root — without a grant the app
    // would authenticate and then fail on its first query, which reads as a
    // broken database rather than a missing permission.
    const user = target.credentials.user;
    if (user && /^[a-z][a-z0-9_]*$/.test(user)) {
      await mysqlExec(target, `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${user}'@'%'`);
      await mysqlExec(target, "FLUSH PRIVILEGES");
    }
  },

  async drop(target, name) {
    await mysqlExec(target, `DROP DATABASE \`${name}\``);
  },
};

const mongodbAdmin: DatabaseAdmin = {
  supported: true,
  system: ["admin", "local", "config"],

  async list(target) {
    const result = await mongo(target, "admin", "db.adminCommand({listDatabases:1}).databases.forEach(d => print(d.name))");
    return result ? lines(result) : [];
  },

  async create(target, name) {
    // Mongo creates a database on its first write, so a name alone would exist
    // in the panel and nowhere else. One empty collection is the cheapest way
    // to make the listing tell the truth; the UI says it does this.
    await mongo(target, name, 'db.createCollection("runpanel_init")');
  },

  async drop(target, name) {
    await mongo(target, name, "db.dropDatabase()");
  },
};

const admins: Record<string, DatabaseAdmin> = {
  postgresql: postgresqlAdmin,
  mysql: mysqlAdmin,
  mongodb: mongodbAdmin,
  // Redis has sixteen numbered databases and no way to name one. Offering a
  // form that cannot work is worse than saying so.
  redis: unsupported,
};

export function databaseAdmin(type: string): DatabaseAdmin {
  return admins[type] ?? unsupported;
}

/**
 * What the engine needs to be talked to. Lives here rather than in a route so
 * both the collection and the item handler decrypt the credentials the same
 * way — and so a route file keeps exporting only its HTTP verbs.
 */
export function serviceTarget(service: ServicesTable): ServiceTarget {
  let credentials = { user: "", password: "", database: "" };
  try {
    credentials = { ...credentials, ...JSON.parse(decrypt(service.credentials)) };
  } catch {
    /* an unreadable credential yields an engine call that fails loudly */
  }
  return { containerName: service.container_name, credentials };
}

// --- engine plumbing --------------------------------------------------------

/**
 * Exported so the backup dumpers build the call the same way. How a password
 * reaches an engine is a decision with a rationale (see the module header); it
 * should be made once, not re-made by whoever writes the next caller.
 */
export function execArgs(target: ServiceTarget, env: Record<string, string>): string[] {
  const args = ["exec"];
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push(target.containerName);
  return args;
}

async function psql(target: ServiceTarget, statement: string): Promise<void> {
  await docker(
    [
      ...execArgs(target, { PGPASSWORD: target.credentials.password }),
      "psql", "-U", target.credentials.user, "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-c", statement,
    ],
    { timeout: EXEC_TIMEOUT }
  );
}

async function mysqlExec(target: ServiceTarget, statement: string): Promise<void> {
  await docker(
    [
      ...execArgs(target, { MYSQL_PWD: target.credentials.password }),
      "mysql", "-u", "root", "-e", statement,
    ],
    { timeout: EXEC_TIMEOUT }
  );
}

/**
 * `mongosh` in Mongo 6+, `mongo` in 5 and earlier. Tried in that order rather
 * than branched on the version string, which is a label and not a promise.
 */
async function mongo(target: ServiceTarget, database: string, script: string): Promise<string> {
  const { user, password } = target.credentials;

  for (const binary of ["mongosh", "mongo"]) {
    const result = await dockerTry(
      [
        ...execArgs(target, {}),
        binary, "--quiet",
        ...(user ? ["-u", user, "-p", password, "--authenticationDatabase", "admin"] : []),
        database, "--eval", script,
      ],
      { timeout: EXEC_TIMEOUT }
    );
    if (result) return result.stdout;
  }

  throw new Error("Nessun client mongo disponibile nel container.");
}
