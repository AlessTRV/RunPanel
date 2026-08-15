import net from "net";
import os from "os";
import { compileRules, isAllowed, normalizeAddress } from "@/lib/ip-access";
import { AccessRow, readAccess } from "@/lib/access-columns";
import { GateKind, closeGate, gateStatus, openGate } from "./access-gate";

/**
 * Turning the stored answer into a running gate.
 *
 * The column semantics live in `lib/access-columns.ts` and the socket work in
 * `access-gate.ts`; this is the seam between them, and the only place that
 * knows both the store and the listener.
 */

export {
  readAccess,
  isRestricted,
  publishArg,
  listenPort,
  type AccessRow,
  type AccessState,
} from "@/lib/access-columns";

/**
 * Make the running gates match the row.
 *
 * Call it AFTER the container or process has been (re)started, never before:
 * while the old one is still publishing on every interface the public port is
 * taken, and binding it yields an `EADDRINUSE` rather than a gate.
 */
export async function syncGate(
  kind: GateKind,
  id: string,
  row: AccessRow,
  opts: { publicPort: number | null; label: string }
): Promise<void> {
  const access = readAccess(row);

  if (access.mode !== "restricted" || !access.port || !opts.publicPort) {
    await closeGate(kind, id);
    return;
  }

  // Compiled once per change rather than per connection: the gate consults this
  // predicate on every accepted socket.
  const rules = compileRules(access.allow);

  await openGate({
    kind,
    id,
    label: opts.label,
    publicPort: opts.publicPort,
    targetPort: access.port,
    allow: access.allow,
    matches: (address) => isAllowed(address, rules),
  });
}

/* ---------------------------------------------------------------------------
 * Is the app really behind the gate?
 *
 * A container is: Docker binds what the publish spec says and the process
 * inside has no say. A native process is only there if it honoured `HOST` —
 * and an app with a hardcoded `app.listen(port)` does not, which leaves it
 * listening on every interface at the moved port, reachable without going
 * through the gate at all.
 *
 * So it is checked rather than assumed. The panel tries to reach the moved port
 * from one of its own non-loopback addresses: if that connects, the app is
 * listening wider than it was told to, and the interface says so instead of
 * showing a restriction that is not one.
 * ------------------------------------------------------------------------- */

// On `globalThis` for the same reason as the gate map: written from wherever an
// app was last started, read by the detail page, and those are not guaranteed
// to be the same module instance.
const globalRef = globalThis as typeof globalThis & { __runpanelAccessLeaks?: Map<string, string> };
const leaks: Map<string, string> = (globalRef.__runpanelAccessLeaks ??= new Map());

/** A non-loopback IPv4 of this host, to originate the probe from. */
function ownExternalAddress(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      const isV4 = entry.family === "IPv4" || (entry.family as unknown as number) === 4;
      if (isV4 && !entry.internal && !entry.address.startsWith("169.254.")) return entry.address;
    }
  }
  return null;
}

function connects(host: string, port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (answer: boolean) => {
      socket.destroy();
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => done(false), timeout);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Record whether the moved port is reachable from outside loopback.
 *
 * Retried for a few seconds because it runs right after a start, and an app
 * that has not bound yet would otherwise read as "nothing listening" — which
 * looks exactly like the good outcome.
 */
export async function checkLoopbackLeak(projectId: string, loopbackPort: number): Promise<void> {
  const address = ownExternalAddress();
  // Nothing to probe from. Reported as no leak rather than as a warning nobody
  // can act on; the alternative is crying wolf on a host with one interface.
  if (!address) {
    leaks.delete(projectId);
    return;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (await connects(address, loopbackPort, 1000)) {
      leaks.set(projectId, address);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  leaks.delete(projectId);
}

/** The address the moved port answered on, or null when it is properly hidden. */
export function leakReport(projectId: string): string | null {
  return leaks.get(projectId) ?? null;
}

export function forgetLeak(projectId: string): void {
  leaks.delete(projectId);
}

export interface GateReport {
  running: boolean;
  publicPort: number | null;
  targetPort: number | null;
  rejections: { address: string; attempts: number; lastAt: string }[];
  /** Set when the moved port answered from outside loopback — see above. */
  leakingFrom: string | null;
}

/** What the detail pages show about a target's gate. */
export function reportGate(kind: GateKind, id: string): GateReport {
  const leakingFrom = kind === "project" ? leakReport(id) : null;
  const status = gateStatus(kind, id);
  if (!status) {
    return { running: false, publicPort: null, targetPort: null, rejections: [], leakingFrom };
  }

  return {
    running: true,
    publicPort: status.publicPort,
    targetPort: status.targetPort,
    // The gate records what the socket reported, which for an IPv4 peer on a
    // dual-stack listener is `::ffff:192.168.1.14`. Normalised here, at the
    // edge: that string is both what the operator reads and what the Consenti
    // button turns into a rule, and neither should carry the mapping.
    rejections: status.rejections.map((r) => ({
      ...r,
      address: normalizeAddress(r.address) ?? r.address,
    })),
    leakingFrom,
  };
}

/**
 * Open every gate the store asks for, at boot.
 *
 * A gate lives in this process and dies with it, so nothing is reachable until
 * this runs — which is the fail-closed behaviour the feature promises, and the
 * reason the interface says so rather than leaving it to be discovered.
 *
 * A target whose upstream is down still gets its gate: the client is dropped
 * either way, and the alternative is a port whose openness depends on whether a
 * container happened to be up at the moment the panel booted.
 */
export async function reconcileGates(): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = await getDb();

  const services = await db
    .selectFrom("services")
    .select(["id", "name", "port", "access_mode", "access_allow", "access_port"])
    .where("access_mode", "=", "restricted")
    .execute();

  const projects = await db
    .selectFrom("projects")
    .select(["id", "name", "port", "access_mode", "access_allow", "access_port"])
    .where("access_mode", "=", "restricted")
    .execute();

  let opened = 0;
  let failed = 0;

  const targets: { kind: GateKind; id: string; name: string; port: number | null; row: AccessRow }[] = [
    ...services.map((row) => ({ kind: "service" as const, id: row.id, name: row.name, port: row.port, row })),
    ...projects.map((row) => ({ kind: "project" as const, id: row.id, name: row.name, port: row.port, row })),
  ];

  for (const target of targets) {
    try {
      await syncGate(target.kind, target.id, target.row, { publicPort: target.port, label: target.name });
      opened += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        `[RunPanel] access gate for ${target.kind} ${target.name}: ${(err as Error).message}`
      );
    }
  }

  if (opened > 0 || failed > 0) {
    console.log(`[RunPanel] Access gates: ${opened} aperti${failed > 0 ? `, ${failed} non aperti` : ""}`);
  }
}
