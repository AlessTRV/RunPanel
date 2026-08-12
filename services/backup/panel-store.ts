import fs from "fs";
import path from "path";
import crypto from "crypto";
import { sql } from "kysely";
import { getSecret } from "@/lib/config";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { docker, dockerToFile, dockerTry } from "../docker/cli";
import { execArgs, serviceTarget } from "../service-databases";
import { DumpSkipped } from "./dumpers";
import type { RunContext, StagedFile } from "./types";

/**
 * A backup of RunPanel's own store.
 *
 * Without it the archive can restore every database the panel manages and not
 * the panel: which projects existed, how they were built, which encrypted env
 * var belonged to which of them. That is the difference between a restore and
 * an afternoon of retyping.
 */

export interface PanelStoreDump {
  files: StagedFile[];
  meta: Record<string, unknown>;
}

function stage(ctx: RunContext, entryPath: string): string {
  const absolute = path.join(ctx.stagingDir, entryPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  return absolute;
}

function sha256Of(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export async function dumpPanelStore(
  ctx: RunContext,
  includeSecret: boolean
): Promise<PanelStoreDump> {
  const env = getEnv();
  ctx.log(`→ store del pannello (${env.db.driver})`);

  const dump =
    env.db.driver === "sqlite"
      ? await dumpSqlite(ctx, env.db.file)
      : await dumpPostgres(ctx);

  const files = [dump.file];

  if (includeSecret) {
    // Opt-in, and the UI says plainly what it means: with this line the archive
    // decrypts itself, which is what makes a restore onto a fresh machine
    // possible and what makes a leaked archive a complete credential dump.
    const secretPath = stage(ctx, "panel/secret.key");
    fs.writeFileSync(secretPath, getSecret(), { mode: 0o600 });
    files.push({
      absolutePath: secretPath,
      entryPath: "panel/secret.key",
      bytes: fs.statSync(secretPath).size,
      sha256: sha256Of(secretPath),
      precompressed: false,
    });
    ctx.log("  chiave di cifratura inclusa su richiesta esplicita");
  }

  return { files, meta: { ...dump.meta, includesSecretKey: includeSecret } };
}

/**
 * SQLite: `VACUUM INTO`, never a copy of the file.
 *
 * Under WAL, `cp runpanel.db` silently omits every page that is committed but
 * not yet checkpointed. The copy opens, looks complete, and is missing the most
 * recent writes — which is the worst possible failure, because it is invisible
 * until the day it is restored.
 */
async function dumpSqlite(
  ctx: RunContext,
  sourceFile: string
): Promise<{ file: StagedFile; meta: Record<string, unknown> }> {
  const entryPath = "panel/runpanel.db";
  const destination = stage(ctx, entryPath);
  fs.rmSync(destination, { force: true });

  // Through the live connection, so SQLite serialises this against whatever
  // else the panel is doing rather than racing it.
  const db = await getDb();
  await sql`VACUUM INTO ${sql.lit(destination)}`.execute(db);

  const verification = await verifySqlite(destination);
  ctx.log(`  ${verification.integrity}, ${verification.projects} progetti`);
  if (verification.integrity !== "ok") {
    throw new Error(`Il dump dello store non supera integrity_check: ${verification.integrity}`);
  }

  return {
    file: {
      absolutePath: destination,
      entryPath,
      bytes: fs.statSync(destination).size,
      sha256: sha256Of(destination),
      precompressed: false,
    },
    meta: {
      driver: "sqlite",
      method: "VACUUM INTO",
      sourceFile: path.basename(sourceFile),
      integrityCheck: verification.integrity,
      projectCount: verification.projects,
      restoreWith: "sostituzione del file a pannello fermo",
    },
  };
}

/**
 * Open the result read-only and ask SQLite whether it is a database at all.
 *
 * A dump nobody verified is a dump nobody can trust, and the row count goes
 * into the manifest so a suspiciously empty archive is visible in the panel
 * rather than discovered during a restore.
 */
async function verifySqlite(file: string): Promise<{ integrity: string; projects: number }> {
  const { default: SQLite } = await import("better-sqlite3");
  const probe = new SQLite(file, { readonly: true });
  try {
    const integrity = probe.pragma("integrity_check", { simple: true });
    const row = probe.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
    return { integrity: String(integrity), projects: row.n };
  } finally {
    probe.close();
  }
}

/**
 * Postgres: do not assume the host has `pg_dump`, and never assume its version.
 *
 * The client has to be at least the server's major or the dump is unrestorable,
 * so the tag is derived from what the server actually reports. When the panel's
 * own database happens to be one of the services RunPanel manages — people do
 * this — talking to that container directly is both simpler and exact.
 */
async function dumpPostgres(
  ctx: RunContext
): Promise<{ file: StagedFile; meta: Record<string, unknown> }> {
  const entryPath = "panel/runpanel.dump";
  const destination = stage(ctx, entryPath);

  const db = await getDb();
  const versionRow = await sql<{ server_version_num: string }>`SHOW server_version_num`.execute(db);
  const versionNum = Number(versionRow.rows[0]?.server_version_num ?? 0);
  const major = versionNum >= 100000 ? Math.floor(versionNum / 10000) : 16;

  const connection = postgresConnection();
  const managed = await matchManagedService(connection);

  const dumpArgs = [
    "pg_dump",
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "-U", connection.user,
    "-d", connection.database,
  ];

  let args: string[];
  let method: string;

  if (managed) {
    ctx.log(`  il database del pannello è il servizio "${managed.name}": lo leggo dal suo container`);
    args = [...execArgs(serviceTarget(managed), { PGPASSWORD: connection.password }), ...dumpArgs];
    method = `docker exec ${managed.container_name}`;
  } else {
    const image = `postgres:${major}-alpine`;
    if (!(await dockerTry(["image", "inspect", image], { timeout: 15_000 }))) {
      ctx.log(`  scarico ${image} per avere un client della stessa versione del server`);
      await docker(["pull", image], { timeout: 300_000 });
    }
    args = [
      "run", "--rm",
      // The same host-reachability trick the service provisioner uses, rather
      // than --network host, which does not exist on Docker Desktop.
      "--add-host=host.docker.internal:host-gateway",
      "-e", `PGPASSWORD=${connection.password}`,
      image,
      ...dumpArgs,
      // "localhost" inside the container means the container, so it has to be
      // rewritten to the gateway name added above.
      "-h", hostFromContainer(connection.host),
      "-p", String(connection.port),
    ];
    method = `docker run ${image}`;
  }

  const result = await dockerToFile(args, destination, {
    // The custom format is already compressed.
    compress: false,
    onStderr: (line) => ctx.log(`  ${line}`),
    signal: ctx.signal,
  });

  return {
    file: {
      absolutePath: destination,
      entryPath,
      bytes: fs.statSync(destination).size,
      sha256: result.sha256,
      precompressed: true,
    },
    meta: {
      driver: "postgres",
      serverVersion: versionNum,
      clientMajor: major,
      method,
      format: "pg-custom",
      restoreWith: "pg_restore --clean --if-exists, a pannello fermo",
    },
  };
}

interface PgConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

function postgresConnection(): PgConnection {
  const { db } = getEnv();
  if (db.driver !== "postgres") throw new DumpSkipped("Lo store del pannello non è Postgres");

  let host = db.host ?? "localhost";
  let port = db.port;
  let user = db.user ?? "";
  let password = db.password ?? "";
  let database = db.database ?? "";

  if (db.connectionString) {
    const url = new URL(db.connectionString);
    host = decodeURIComponent(url.hostname) || host;
    port = url.port ? Number(url.port) : port;
    user = decodeURIComponent(url.username) || user;
    password = decodeURIComponent(url.password) || password;
    database = url.pathname.replace(/^\//, "") || database;
  }

  return { host, port, user, password, database };
}

/**
 * Is the panel's own database one of the containers RunPanel provisioned? The
 * host it is reached at is the giveaway: a managed service is published on a
 * port of the host itself.
 */
async function matchManagedService(connection: PgConnection) {
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(connection.host)) {
    return null;
  }

  const db = await getDb();
  const services = await db
    .selectFrom("services")
    .selectAll()
    .where("type", "=", "postgresql")
    .where("port", "=", connection.port)
    .execute();

  return services[0] ?? null;
}

/** The host name a container has to use to reach the panel's own host. */
export function hostFromContainer(host: string): string {
  return ["localhost", "127.0.0.1", "::1"].includes(host) ? "host.docker.internal" : host;
}
