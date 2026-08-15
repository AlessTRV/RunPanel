/**
 * What the three `access_*` columns mean, and what they imply for a listener.
 *
 * Separate from `services/access.ts`, which runs the gate, because this half is
 * pure and decides the one thing that cannot be walked back: whether a port
 * ends up published on every interface. It is worth a test that runs without a
 * Docker daemon, and zero imports is what buys that — the standalone suite
 * loads this file directly, where Node resolves neither the `@/` alias nor an
 * extensionless relative specifier.
 */

export type AccessMode = "open" | "restricted";

/** The three columns, identical on `services` and on `projects`. */
export interface AccessRow {
  access_mode: AccessMode | null;
  access_allow: string | null;
  access_port: number | null;
}

export interface AccessState {
  mode: AccessMode;
  /** Rule texts as stored. Empty under `restricted` means "only this machine". */
  allow: string[];
  /** The loopback port the real listener moved to; null while open. */
  port: number | null;
}

/**
 * Read the columns, tolerating anything.
 *
 * A row written before migration 008 holds NULLs, and a restored or
 * hand-edited store can hold something that is not a JSON array at all. Every
 * one of those resolves to `open`, which is what the port already was. The
 * alternative — treating an unreadable value as `restricted` — turns a bad
 * string into an unreachable database and calls it security.
 */
export function readAccess(row: AccessRow): AccessState {
  const mode: AccessMode = row.access_mode === "restricted" ? "restricted" : "open";

  let allow: string[] = [];
  if (row.access_allow) {
    try {
      const parsed = JSON.parse(row.access_allow);
      if (Array.isArray(parsed)) allow = parsed.filter((rule): rule is string => typeof rule === "string");
    } catch {
      /* an unreadable list is an empty one */
    }
  }

  return { mode, allow, port: mode === "restricted" ? row.access_port : null };
}

export function isRestricted(row: AccessRow): boolean {
  return readAccess(row).mode === "restricted";
}

/**
 * The `-p` value for `docker run`.
 *
 * Open is the bare `host:container` this panel has always written, which binds
 * every interface — including the public one, which is the whole reason this
 * feature exists. Restricted publishes on loopback and on the moved port, so
 * the only way in is through the gate.
 *
 * A restricted row with no port falls back to open rather than to something
 * clever. It cannot happen through the API, and inventing a binding for a
 * half-written row would be worse than doing what the row plainly says.
 */
export function publishArg(row: AccessRow, publicPort: number, containerPort: number): string {
  const access = readAccess(row);
  if (access.mode === "restricted" && access.port) {
    return `127.0.0.1:${access.port}:${containerPort}`;
  }
  return `${publicPort}:${containerPort}`;
}

/**
 * Where the real listener belongs: the moved port while restricted, the
 * published one otherwise. This is the number a process gets as `PORT`.
 */
export function listenPort(row: AccessRow, publicPort: number): number {
  const access = readAccess(row);
  return access.mode === "restricted" && access.port ? access.port : publicPort;
}
