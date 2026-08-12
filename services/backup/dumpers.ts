import fs from "fs";
import path from "path";
import type { ServicesTable } from "@/lib/db/schema";
import { docker, dockerToFile, dockerTry } from "../docker/cli";
import { databaseAdmin, execArgs, serviceTarget, type ServiceTarget } from "../service-databases";
import { formatBytes } from "@/lib/format";
import type { RunContext, StagedFile } from "./types";

/**
 * Dumping a managed database.
 *
 * Every dump runs *inside the service's own container*, which is not a
 * convenience — it is the only way to guarantee the client and the server are
 * the same version. A `pg_dump` from the host that happens to be a major behind
 * produces a file `pg_restore` will refuse, and it produces it without
 * complaining, so the problem surfaces on the day of the restore.
 *
 * Output never passes through `docker()`: that is `execFile` with a 16 MB
 * ceiling, and a database is not obliged to be smaller than that.
 */

export interface DumpResult extends StagedFile {
  meta: Record<string, unknown>;
}

/** Raised where the state, not the command, is the problem. */
export class DumpSkipped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DumpSkipped";
  }
}

const PROBE_TIMEOUT = 10_000;

async function isRunning(containerName: string): Promise<boolean> {
  const result = await dockerTry(
    ["inspect", "-f", "{{.State.Running}}", containerName],
    { timeout: PROBE_TIMEOUT }
  );
  return result?.stdout.trim() === "true";
}

/** Which of several candidate binaries the image actually ships. */
async function findBinary(target: ServiceTarget, candidates: string[]): Promise<string | null> {
  for (const binary of candidates) {
    const found = await dockerTry(
      [...execArgs(target, {}), "sh", "-c", `command -v ${binary}`],
      { timeout: PROBE_TIMEOUT }
    );
    if (found && found.stdout.trim()) return binary;
  }
  return null;
}

/** Recorded in the artifact so a future restore can refuse a bad pairing. */
async function toolVersion(target: ServiceTarget, binary: string): Promise<string | null> {
  const result = await dockerTry(
    [...execArgs(target, {}), binary, "--version"],
    { timeout: PROBE_TIMEOUT }
  );
  return result?.stdout.trim().split("\n")[0] ?? null;
}

function stagePath(ctx: RunContext, entryPath: string): string {
  const absolute = path.join(ctx.stagingDir, entryPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  return absolute;
}

/**
 * The databases worth offering for a per-database backup. Engines without named
 * databases — Redis — answer with an empty list, and the whole server is dumped
 * instead.
 */
export async function listDumpableDatabases(service: ServicesTable): Promise<string[]> {
  const admin = databaseAdmin(service.type);
  if (!admin.supported) return [];

  const target = serviceTarget(service);
  const all = await admin.list(target);
  return all.filter((name) => !admin.system.includes(name));
}

interface DumpOutput {
  /** Of the bytes as written, so `sha256sum` on the extracted file agrees. */
  sha256: string;
  meta: Record<string, unknown>;
}

interface EngineDump {
  /** Path inside the archive, relative to the run root. */
  entry: (serviceName: string, database: string | null) => string;
  run: (
    target: ServiceTarget,
    database: string | null,
    destination: string,
    ctx: RunContext
  ) => Promise<DumpOutput>;
}

const postgres: EngineDump = {
  entry: (serviceName, database) =>
    `databases/${serviceName}/${database ?? "all"}.sql.gz`,

  async run(target, database, destination, ctx) {
    const binary = database ? "pg_dump" : "pg_dumpall";
    if (!(await findBinary(target, [binary]))) {
      throw new DumpSkipped(`L'immagine non contiene ${binary}`);
    }

    // A service is a server, not a database: dumping only the one named in the
    // credentials would silently leave `staging` and `analytics` out. Without a
    // named database we take the lot, roles and grants included, which is what
    // `pg_dumpall` is for.
    const args = database
      ? [
          ...execArgs(target, { PGPASSWORD: target.credentials.password }),
          "pg_dump",
          "-U", target.credentials.user,
          "--format=plain", "--create", "--clean", "--if-exists",
          "--no-owner", "--no-privileges",
          "-d", database,
        ]
      : [
          ...execArgs(target, { PGPASSWORD: target.credentials.password }),
          "pg_dumpall",
          "-U", target.credentials.user,
          "--clean", "--if-exists",
        ];

    const result = await dockerToFile(args, destination, {
      compress: true,
      onStderr: (line) => ctx.log(`  ${line}`),
      signal: ctx.signal,
    });

    return {
      sha256: result.sha256,
      meta: {
        tool: binary,
        toolVersion: await toolVersion(target, binary),
        format: "plain-sql",
        restoreWith: "psql -v ON_ERROR_STOP=1 -U <user> -d postgres",
        uncompressedBytes: result.rawBytes,
      },
    };
  },
};

const mysql: EngineDump = {
  entry: (serviceName, database) => `databases/${serviceName}/${database ?? "all"}.sql.gz`,

  async run(target, database, destination, ctx) {
    // MariaDB images renamed the client; the fallback mirrors the mongosh/mongo
    // one already in service-databases.ts.
    const binary = await findBinary(target, ["mysqldump", "mariadb-dump"]);
    if (!binary) throw new DumpSkipped("L'immagine non contiene mysqldump né mariadb-dump");

    const args = [
      ...execArgs(target, { MYSQL_PWD: target.credentials.password }),
      binary,
      "-u", "root",
      // A consistent snapshot of InnoDB without taking a lock, streamed row by
      // row instead of buffering a table, with binary columns hex-encoded so
      // they survive the round trip.
      "--single-transaction",
      "--quick",
      "--routines",
      "--triggers",
      "--events",
      "--hex-blob",
      "--default-character-set=utf8mb4",
      ...(database ? ["--databases", database] : ["--all-databases"]),
    ];

    const result = await dockerToFile(args, destination, {
      compress: true,
      // mysqldump writes advisory warnings to stderr on a perfectly good dump,
      // so only the exit code is allowed to decide whether this failed.
      onStderr: (line) => ctx.log(`  ${line}`),
      signal: ctx.signal,
    });

    return {
      sha256: result.sha256,
      meta: {
        tool: binary,
        toolVersion: await toolVersion(target, binary),
        format: "plain-sql",
        restoreWith: "mysql -u root",
        uncompressedBytes: result.rawBytes,
      },
    };
  },
};

const mongodb: EngineDump = {
  entry: (serviceName, database) =>
    `databases/${serviceName}/${database ?? "all"}.archive.gz`,

  async run(target, database, destination, ctx) {
    if (!(await findBinary(target, ["mongodump"]))) {
      throw new DumpSkipped("L'immagine non contiene mongodump");
    }

    const args = [
      ...execArgs(target, {}),
      "mongodump",
      // `--archive` with no value writes to stdout, which is exactly the shape
      // we want; `--gzip` means we must not compress it a second time.
      "--archive",
      "--gzip",
      "-u", target.credentials.user,
      "-p", target.credentials.password,
      "--authenticationDatabase", "admin",
      ...(database ? ["--db", database] : []),
    ];

    const result = await dockerToFile(args, destination, {
      compress: false,
      onStderr: (line) => ctx.log(`  ${line}`),
      signal: ctx.signal,
    });

    return {
      sha256: result.sha256,
      meta: {
        tool: "mongodump",
        toolVersion: await toolVersion(target, "mongodump"),
        format: "mongo-archive-gzip",
        restoreWith: "mongorestore --archive --gzip --drop",
        uncompressedBytes: result.rawBytes,
      },
    };
  },
};

const redis: EngineDump = {
  entry: (serviceName) => `databases/${serviceName}/dump.rdb.gz`,

  async run(target, _database, destination, ctx) {
    const password = target.credentials.password;

    // `--rdb -` asks the server for a snapshot over the replication protocol
    // and writes it to stdout: consistent, and with no need to reach into the
    // volume. The password goes through REDISCLI_AUTH rather than `-a` for the
    // same reason MySQL uses MYSQL_PWD — the warning would land in the data.
    const args = [
      ...execArgs(target, password ? { REDISCLI_AUTH: password } : {}),
      "redis-cli",
      "--no-auth-warning",
      "--rdb", "-",
    ];

    try {
      const result = await dockerToFile(args, destination, {
        compress: true,
        onStderr: (line) => ctx.log(`  ${line}`),
        signal: ctx.signal,
      });
      return {
        sha256: result.sha256,
        meta: {
          tool: "redis-cli --rdb",
          toolVersion: await toolVersion(target, "redis-cli"),
          format: "rdb",
          restoreWith: "stop, replace /data/dump.rdb, start",
          uncompressedBytes: result.rawBytes,
        },
      };
    } catch (err) {
      ctx.log(`  redis-cli --rdb non ha funzionato (${(err as Error).message}); provo con BGSAVE`);
      return bgsaveFallback(target, destination, ctx);
    }
  },
};

/**
 * Older builds refuse `--rdb -`. Ask the server to write its own snapshot, wait
 * for it to finish, and copy the file out — slower, and it touches the volume,
 * but it is the difference between a backup and no backup.
 */
async function bgsaveFallback(
  target: ServiceTarget,
  destination: string,
  ctx: RunContext
): Promise<DumpOutput> {
  const auth: Record<string, string> = target.credentials.password
    ? { REDISCLI_AUTH: target.credentials.password }
    : {};
  const cli = (...rest: string[]) => [
    ...execArgs(target, auth),
    "redis-cli",
    "--no-auth-warning",
    ...rest,
  ];

  await docker(cli("BGSAVE"), { timeout: 30_000 });

  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const info = await docker(cli("INFO", "persistence"), { timeout: 30_000 });
    if (/rdb_bgsave_in_progress:0/.test(info.stdout)) break;
    if (Date.now() > deadline) throw new Error("BGSAVE non è terminato entro dieci minuti");
    ctx.log("  BGSAVE in corso…");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // `cat`, not `docker cp`: cp wraps the file in a tar stream, and the restore
  // path would then need to know which of the two shapes it was handed.
  const result = await dockerToFile(
    [...execArgs(target, {}), "cat", "/data/dump.rdb"],
    destination,
    { compress: true, signal: ctx.signal }
  );

  return {
    sha256: result.sha256,
    meta: {
      tool: "redis-cli BGSAVE + cat",
      format: "rdb",
      restoreWith: "stop, replace /data/dump.rdb, start",
      uncompressedBytes: result.rawBytes,
    },
  };
}

const ENGINES: Record<string, EngineDump> = {
  postgresql: postgres,
  mysql,
  mongodb,
  redis,
};

/**
 * Dump one database — or a whole server when `database` is null — into the run's
 * staging directory.
 */
export async function dumpServiceDatabase(
  service: ServicesTable,
  database: string | null,
  ctx: RunContext
): Promise<DumpResult> {
  const engine = ENGINES[service.type];
  if (!engine) throw new DumpSkipped(`Nessun dump disponibile per il tipo "${service.type}"`);

  if (!(await isRunning(service.container_name))) {
    // Starting it would change the state of the machine behind the operator's
    // back, at three in the morning, to take a backup. Report instead.
    throw new DumpSkipped("Il servizio è fermo: non è stato possibile leggerlo");
  }

  const target = serviceTarget(service);
  const entryPath = engine.entry(service.name, database);
  const absolutePath = stagePath(ctx, entryPath);

  ctx.log(`→ ${service.name}${database ? ` / ${database}` : " (server completo)"}`);
  const { sha256, meta } = await engine.run(target, database, absolutePath, ctx);

  const stat = fs.statSync(absolutePath);
  ctx.log(`  ${formatBytes(stat.size)}`);

  return {
    absolutePath,
    entryPath,
    bytes: stat.size,
    sha256,
    precompressed: true,
    meta: { ...meta, engine: service.type, version: service.version },
  };
}
