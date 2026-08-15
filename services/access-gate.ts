import net from "net";

/**
 * The panel's own front door for a restricted port.
 *
 * A restricted target stops publishing on every interface and moves its real
 * listener to loopback; this opens the port the operator's clients already know
 * and forwards to it, refusing anything the allowlist does not cover. It is the
 * one mechanism that behaves the same on Windows and on Linux, needs no
 * administrator, and sees the true source address rather than whatever Docker's
 * NAT would have left of it.
 *
 * **Fail-closed, and that is the point.** If the panel is not running, nothing
 * holds the public port and the service is unreachable from outside. For a
 * security control that is the right direction to fail — but it is a change in
 * behaviour, so the interface says it out loud instead of letting it be
 * discovered.
 *
 * Nothing from the rest of the project is imported here, deliberately: the
 * policy arrives as a predicate, so this module is `node:net` and nothing else
 * and the suite can drive it directly with no server, no store and no daemon.
 * The decision it asks about lives in `lib/ip-access.ts`, tested separately.
 */

export type GateKind = "service" | "project";

export interface GateSpec {
  kind: GateKind;
  id: string;
  /** Only for the log line. */
  label: string;
  /** What clients connect to: the port that used to be published directly. */
  publicPort: number;
  /** Where the real listener lives now, on loopback. */
  targetPort: number;
  /** Whether this source may be forwarded. Loopback is the caller's business. */
  matches: (address: string) => boolean;
  /** The rules behind `matches`, carried so the panel can show what is in force. */
  allow: readonly string[];
}

/**
 * Someone the gate turned away.
 *
 * Kept because an operator who has locked themselves out has no other way to
 * find out why: from their side a refused connection and a stopped database
 * look identical, and this is the only place that knows the difference. In
 * memory only — it is a debugging aid for the session, not a log.
 */
export interface Rejection {
  address: string;
  attempts: number;
  /** ISO-8601 of the most recent attempt. */
  lastAt: string;
}

export class GateError extends Error {
  readonly port: number;
  readonly code: string | null;

  constructor(message: string, port: number, code: string | null) {
    super(message);
    this.name = "GateError";
    this.port = port;
    this.code = code;
  }
}

interface Gate {
  spec: GateSpec;
  server: net.Server;
  rejections: Map<string, Rejection>;
}

const REJECTION_MEMORY = 20;

/**
 * Held on `globalThis`, like the database handle and the housekeeping timer.
 *
 * Not only for dev-mode reloads. `instrumentation.ts` is bundled separately
 * from the route handlers, so a plain module-level Map is instantiated twice in
 * the same process: the gates opened at boot went into one copy and every
 * `gateStatus` call read the other. The port was genuinely open and forwarding
 * while the page reported "gate non attivo" — the one discrepancy this feature
 * cannot afford, since it is the difference between a restriction being
 * enforced and merely being claimed.
 */
const globalRef = globalThis as typeof globalThis & { __runpanelGates?: Map<string, Gate> };
const gates: Map<string, Gate> = (globalRef.__runpanelGates ??= new Map());

function gateKey(kind: GateKind, id: string): string {
  return `${kind}:${id}`;
}

function record(gate: Gate, address: string): void {
  const key = address || "unknown";
  // `Date` directly rather than the store's `nowIso`: importing it would pull
  // the database into a module whose whole point is that it needs nothing.
  const lastAt = new Date().toISOString();
  const seen = gate.rejections.get(key);

  if (seen) {
    seen.attempts += 1;
    seen.lastAt = lastAt;
    // Re-insert so the map's own order is least-recent first, which is what
    // makes the eviction below correct.
    gate.rejections.delete(key);
    gate.rejections.set(key, seen);
    return;
  }

  gate.rejections.set(key, { address: key, attempts: 1, lastAt });

  while (gate.rejections.size > REJECTION_MEMORY) {
    const oldest = gate.rejections.keys().next().value;
    if (oldest === undefined) break;
    gate.rejections.delete(oldest);
  }
}

function handle(gate: Gate, socket: net.Socket): void {
  const address = socket.remoteAddress ?? "";

  if (!gate.spec.matches(address)) {
    record(gate, address);
    // Destroyed rather than ended: a refused source gets no bytes and no
    // graceful close, and learns nothing about what is behind the port.
    socket.destroy();
    return;
  }

  socket.setNoDelay(true);

  const upstream = net.connect({ host: "127.0.0.1", port: gate.spec.targetPort });
  upstream.setNoDelay(true);

  // Either end failing takes both down. Without this an upstream that is simply
  // not there (the container is stopped) leaves the client socket open forever.
  const teardown = () => {
    socket.destroy();
    upstream.destroy();
  };

  socket.on("error", teardown);
  upstream.on("error", teardown);
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());

  upstream.on("connect", () => {
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
}

/**
 * Open the gate for a target, or re-point one that is already open.
 *
 * Changing only the rules swaps them in place instead of rebinding: a rule set
 * applies to the next connection, and dropping every live one to say so would
 * make editing the list an outage.
 *
 * Order matters at the call site. Turning a restriction ON means recreating the
 * container (or restarting the process) FIRST, so it releases the public port,
 * and only then opening the gate — the other way round is a guaranteed
 * `EADDRINUSE`. Turning it off is the mirror image: close, then recreate.
 */
export async function openGate(spec: GateSpec): Promise<void> {
  const key = gateKey(spec.kind, spec.id);
  const existing = gates.get(key);

  if (existing && existing.spec.publicPort === spec.publicPort && existing.spec.targetPort === spec.targetPort) {
    existing.spec = spec;
    // A remembered refusal the new rules admit is no longer news. Without this,
    // adding the address that was knocking leaves the notice about it on screen
    // — which reads as "still blocked" right after allowing it.
    for (const [key, rejection] of existing.rejections) {
      if (spec.matches(rejection.address)) existing.rejections.delete(key);
    }
    return;
  }

  if (existing) await closeGate(spec.kind, spec.id);

  const server = net.createServer();
  const gate: Gate = { spec, server, rejections: new Map() };

  server.on("connection", (socket) => handle(gate, socket));

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      reject(
        new GateError(
          err.code === "EADDRINUSE"
            ? `La porta ${spec.publicPort} è già occupata: il servizio la sta ancora pubblicando.`
            : err.message,
          spec.publicPort,
          err.code ?? null
        )
      );
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(spec.publicPort);
  });

  // Past `listening`, an error is a runtime fault on an open gate rather than a
  // failure to open one, and throwing it here would take the process down.
  server.on("error", (err) => {
    console.warn(`[RunPanel] access gate ${spec.label}:${spec.publicPort} — ${err.message}`);
  });

  gates.set(key, gate);
}

/** Close a gate and forget it. Safe to call for a target that has none. */
export async function closeGate(kind: GateKind, id: string): Promise<void> {
  const key = gateKey(kind, id);
  const gate = gates.get(key);
  if (!gate) return;

  gates.delete(key);
  await new Promise<void>((resolve) => gate.server.close(() => resolve()));
}

export interface GateStatus {
  publicPort: number;
  targetPort: number;
  allow: readonly string[];
  rejections: Rejection[];
}

/** What the panel shows about a gate, or null when there is none. */
export function gateStatus(kind: GateKind, id: string): GateStatus | null {
  const gate = gates.get(gateKey(kind, id));
  if (!gate) return null;

  return {
    publicPort: gate.spec.publicPort,
    targetPort: gate.spec.targetPort,
    allow: gate.spec.allow,
    rejections: [...gate.rejections.values()].reverse(),
  };
}

/** Most recent first. Empty when no gate is open. */
export function recentRejections(kind: GateKind, id: string): Rejection[] {
  return gateStatus(kind, id)?.rejections ?? [];
}

export async function closeAllGates(): Promise<void> {
  await Promise.all([...gates.keys()].map((key) => {
    const [kind, id] = key.split(":");
    return closeGate(kind as GateKind, id);
  }));
}

/**
 * A free port on loopback for the real listener to move to.
 *
 * Asking the kernel rather than picking from a range: it is the only party that
 * knows what is taken. The answer is persisted, so the port survives a restart
 * and the container keeps the same publish spec; if something else claims it in
 * the meantime, `docker run` fails loudly, which is the right kind of failure.
 */
export async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("Nessuna porta libera disponibile su loopback"));
      });
    });
  });
}
