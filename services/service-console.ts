import { spawn, type ChildProcess } from "child_process";
import type { ServicesTable } from "@/lib/db/schema";
import { dockerStream, dockerTry } from "./docker/cli";
import { serviceEvents, type ConsoleMode } from "./events";
import { execArgs, serviceTarget, type ServiceTarget } from "./service-databases";

/**
 * Talking to a service.
 *
 * The panel knows the container name, the user and the password — the three
 * things you would otherwise go and look up before typing `docker exec` on the
 * host. This is that command, with the looking-up already done, in three
 * flavours: the engine's own client, a shell, and the container's log.
 *
 * Modelled on `app/api/projects/[projectId]/terminal/route.ts`, which has the
 * same shape and the same reasons — but in a module rather than inside a route,
 * because two routes need it here (the console and the stream) and because a
 * route file should export its HTTP verbs and nothing else.
 *
 * **There is no TTY.** `docker exec -i` with piped stdio cannot allocate one —
 * `-t` fails outright with "the input device is not a TTY" — so every client
 * runs in its non-interactive mode. That is not a limitation to work around: a
 * line-oriented box in a browser is line-oriented anyway. It does mean the
 * flags matter, and `engineCommand()` below is where that is written down.
 */

interface ConsoleSession {
  mode: ConsoleMode;
  /** The `docker exec` child. Null for `logs`, which has nothing to write to. */
  proc: ChildProcess | null;
  /** What `dockerStream` handed back, for `logs`. Null for the exec modes. */
  stop: (() => void) | null;
  /** Replayed to a stream that connects after output has already gone past. */
  buffer: string[];
  lastActivity: number;
}

const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const BUFFER_MAX = 500;
const BUFFER_KEEP = 250;

/**
 * Both hang off `globalThis`, like the shell sessions of the project terminal
 * and for the same reason: re-evaluated on a dev reload, a plain module
 * constant would hand the new copy an empty Map while the `docker exec`
 * processes from before kept running with nothing holding a reference — and
 * would start a second reaper that could not see them either.
 */
const globalRef = globalThis as typeof globalThis & {
  __runpanelServiceConsoles?: Map<string, ConsoleSession>;
  __runpanelServiceConsoleReaper?: NodeJS.Timeout;
};

const sessions = (globalRef.__runpanelServiceConsoles ??= new Map<string, ConsoleSession>());

if (!globalRef.__runpanelServiceConsoleReaper) {
  globalRef.__runpanelServiceConsoleReaper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TIMEOUT_MS) kill(id, session);
    }
  }, 60_000);
  // A cleanup timer must never be the reason the process refuses to exit.
  globalRef.__runpanelServiceConsoleReaper.unref?.();
}

function kill(serviceId: string, session: ConsoleSession): void {
  try {
    session.stop?.();
    session.proc?.kill();
  } catch {
    /* a process that is already gone is the outcome we wanted */
  }
  sessions.delete(serviceId);
}

/**
 * The client to run, per engine, and how its password gets there.
 *
 * Passwords travel as `docker exec -e` and not on the command line — the
 * reasoning is in the header of `services/service-databases.ts`, and
 * `execArgs()` is the one place that builds it. Mongo is the exception the
 * existing `mongo()` helper already makes: `mongosh` has no password
 * environment variable, so it takes one on argv there too.
 */
function engineCommand(
  service: ServicesTable,
  target: ServiceTarget,
  mongoBinary: string
): { env: Record<string, string>; argv: string[] } {
  const { user, password, database } = target.credentials;

  switch (service.type) {
    case "postgresql":
      // `POSTGRES_USER` is effectively the superuser of the official image, so
      // this is the same identity the panel already administers with. Aligned
      // output is psql's default and does not depend on a TTY; what it loses
      // without one is the prompt — hence `--echo-queries`, so the transcript
      // says what produced each block — and the pager, which is turned off
      // explicitly rather than left to guess.
      //
      // `PSQL_HISTORY` is not tidiness. `$HOME` for the postgres user *is* the
      // data directory, so every session would otherwise drop a `.psql_history`
      // inside the database.
      //
      // `ON_ERROR_STOP` stays unset: a console has to survive a typo.
      return {
        env: {
          PGPASSWORD: password,
          PGCLIENTENCODING: "UTF8",
          PAGER: "cat",
          PSQL_PAGER: "cat",
          PSQL_HISTORY: "/dev/null",
        },
        argv: [
          "psql", "-U", user, "-d", database || "postgres",
          "--echo-queries", "--pset=pager=off",
        ],
      };

    case "mysql":
      // Two flags carry this row. `--table`: without a TTY the client enters
      // batch mode and prints bare tab-separated rows, so a query that gives a
      // grid in a terminal comes back here as columns nobody can read.
      // `--force`: in that same batch mode a single syntax error **terminates
      // the client**, so without it the first typo ends the session instead of
      // printing an error. `--unbuffered` flushes per statement rather than
      // letting results sit in a pipe.
      //
      // `-u root` because `MYSQL_ROOT_PASSWORD` is the same password and root
      // is who the panel's own database operations already use.
      return {
        env: { MYSQL_PWD: password },
        argv: [
          "mysql", "-u", "root",
          "--table", "--force", "--unbuffered", "--show-warnings", "--skip-pager",
          "--default-character-set=utf8mb4",
          ...(database ? ["-D", database] : []),
        ],
      };

    case "redis":
      // `--no-raw` is redis's `--table`: with stdout on a pipe the client picks
      // raw output, which drops the `1)` numbering and the quoting and prints
      // binary values as unescaped bytes straight into an SSE frame.
      // `REDISCLI_AUTH` over `-a` is the precedent the backup dumper already
      // set, and it also silences the warning `-a` prints on stderr.
      return {
        env: password ? { REDISCLI_AUTH: password } : {},
        argv: ["redis-cli", "-n", database || "0", "--no-raw", "--no-auth-warning"],
      };

    case "mongodb":
      // `--shell` is the one that matters: with stdin on a pipe mongosh treats
      // it as a script and prints nothing that was not explicitly printed, so
      // without it a typed expression evaluates to silence. `--quiet` drops the
      // banner. The password goes on argv because mongosh has no environment
      // variable for it — the same exception `mongo()` already makes.
      return {
        env: {},
        argv: [
          mongoBinary, "--quiet", "--shell",
          ...(user ? ["-u", user, "-p", password, "--authenticationDatabase", "admin"] : []),
          ...(database ? [database] : []),
        ],
      };

    default:
      throw new Error(`Nessuna console per il motore "${service.type}".`);
  }
}

/**
 * `mongosh` in Mongo 6+, `mongo` before it. Asked rather than derived from the
 * version string, which is a label and not a promise — the same judgement the
 * `mongo()` helper makes, except that a long-lived session cannot try one and
 * fall back to the other after the fact.
 */
async function resolveMongoBinary(target: ServiceTarget): Promise<string> {
  const found = await dockerTry([...execArgs(target, {}), "mongosh", "--version"], {
    timeout: 15_000,
  });
  return found ? "mongosh" : "mongo";
}

function push(serviceId: string, session: ConsoleSession, text: string): void {
  // Output counts as activity for a session someone is typing into, and
  // deliberately does not for `logs`. A chatty container would otherwise keep
  // its own `docker logs -f` alive for as long as it keeps talking — which is
  // forever, long after the tab that asked for it was closed. What holds a log
  // follower open is a viewer, and `touchConsole()` from the stream's keepalive
  // is how one says so.
  if (session.mode !== "logs") session.lastActivity = Date.now();
  session.buffer.push(text);
  if (session.buffer.length > BUFFER_MAX) {
    session.buffer = session.buffer.slice(-BUFFER_KEEP);
  }
  serviceEvents.emit(serviceId, { type: "console:output", mode: session.mode, text });
}

/**
 * Open a session, replacing whatever was open before.
 *
 * One at a time per service, like the project terminal: a second shell on the
 * same container is a thing an operator can want and a thing this panel has no
 * way to show two of.
 */
export async function openConsole(
  service: ServicesTable,
  mode: ConsoleMode
): Promise<{ mode: ConsoleMode }> {
  closeConsole(service.id);

  const session: ConsoleSession = {
    mode,
    proc: null,
    stop: null,
    buffer: [],
    lastActivity: Date.now(),
  };
  sessions.set(service.id, session);

  if (mode === "logs") {
    // Nothing to write to and nothing to authenticate: `docker logs -f` is a
    // stream, not a session, and `dockerStream` already delivers whole lines.
    session.stop = dockerStream(
      ["logs", "-f", "--tail", "200", service.container_name],
      (line) => push(service.id, session, `${line}\n`),
      (code) => {
        serviceEvents.emit(service.id, { type: "console:closed", mode, code });
        sessions.delete(service.id);
      }
    );
    return { mode };
  }

  const target = serviceTarget(service);

  let args: string[];
  if (mode === "shell") {
    args = [...execArgs(target, {}, { interactive: true }), "/bin/sh"];
  } else {
    const mongoBinary =
      service.type === "mongodb" ? await resolveMongoBinary(target) : "mongosh";
    const { env, argv } = engineCommand(service, target, mongoBinary);
    args = [...execArgs(target, env, { interactive: true }), ...argv];
  }

  const proc = spawn("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  session.proc = proc;

  proc.stdout?.on("data", (chunk: Buffer) => push(service.id, session, chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => push(service.id, session, chunk.toString()));

  proc.on("close", (code) => {
    push(service.id, session, `\n[sessione chiusa, codice ${code ?? 0}]\n`);
    serviceEvents.emit(service.id, { type: "console:closed", mode, code });
    sessions.delete(service.id);
  });

  proc.on("error", (err) => {
    push(service.id, session, `\n[impossibile aprire la sessione: ${err.message}]\n`);
    serviceEvents.emit(service.id, { type: "console:closed", mode, code: null });
    sessions.delete(service.id);
  });

  return { mode };
}

/** False when there is no session, or when the mode has no stdin to write to. */
export function writeConsole(serviceId: string, input: string): boolean {
  const session = sessions.get(serviceId);
  if (!session?.proc?.stdin?.writable) return false;

  session.proc.stdin.write(input);
  session.lastActivity = Date.now();
  return true;
}

export function closeConsole(serviceId: string): void {
  const session = sessions.get(serviceId);
  if (session) kill(serviceId, session);
}

export function consoleState(serviceId: string): { active: boolean; mode: ConsoleMode } | null {
  const session = sessions.get(serviceId);
  return session ? { active: true, mode: session.mode } : null;
}

/**
 * "Somebody is still watching."
 *
 * Called from the stream's keepalive, every 25 seconds — comfortably inside the
 * ten-minute idle timeout, so one open viewer holds a session and no viewer
 * lets it go. It is what gives `logs` a liveness rule at all, since its output
 * deliberately does not count as activity; for the other two it is harmless
 * belt and braces on a session whose typing already counts.
 */
export function touchConsole(serviceId: string): void {
  const session = sessions.get(serviceId);
  if (session) session.lastActivity = Date.now();
}

/** What has already gone past, for a stream that connects mid-session. */
export function consoleBacklog(serviceId: string): string[] {
  return sessions.get(serviceId)?.buffer ?? [];
}
