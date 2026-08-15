import { execFile } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { promisify } from "util";
import { config } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { staleWhileRevalidate } from "@/lib/stale-cache";
import { docker, dockerTry, lines } from "../docker/cli";
import { toolchainPath } from "../env-utils";
import { ownedFilters } from "../docker/labels";
import { UNIT_NAME } from "./render";

/**
 * What this machine already does about starting RunPanel at boot.
 *
 * Everything here is read-only and forgiving: a missing binary, a cron with no
 * crontab, a systemd that refuses to answer — none of them are errors, they are
 * facts about the host, and a probe that throws on one of them tells you
 * nothing about the other six.
 */

const exec = promisify(execFile);
const PROBE_TIMEOUT = 5_000;

interface Ran {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run a host command. Never throws; a failure is a result like any other. */
async function run(command: string, args: string[]): Promise<Ran> {
  try {
    const { stdout, stderr } = await exec(command, args, {
      timeout: PROBE_TIMEOUT,
      windowsHide: true,
      // Resolve tools the way the panel's children resolve them. Probing with
      // systemd's bare PATH reports "pm2 non è installato o non è nel PATH" on
      // a host where pm2 is installed in `~/.bun/bin` and running fine.
      env: { ...process.env, PATH: toolchainPath(), Path: toolchainPath() },
    });
    return { ok: true, stdout: stdout.toString().trim(), stderr: stderr.toString().trim(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false,
      stdout: (e.stdout ?? "").toString().trim(),
      stderr: (e.stderr ?? "").toString().trim(),
      code: typeof e.code === "number" ? e.code : null,
    };
  }
}

export interface HostEnvironment {
  platform: NodeJS.Platform;
  release: string;
  /** WSL is Linux enough to confuse a probe and not enough to boot a unit. */
  wsl: boolean;
  /** Null on Windows, where the idea does not apply. */
  uid: number | null;
  root: boolean;
  user: string;
  containerised: boolean;
  containerRuntime: string | null;
  pid1: string | null;
  nodePath: string;
  workingDirectory: string;
  dataDir: string;
  port: number;
}

export interface UnitState {
  available: boolean;
  installed: boolean;
  enabled: boolean;
  active: boolean;
  fragmentPath: string | null;
  detail: string | null;
}

export interface AutostartProbe {
  environment: HostEnvironment;
  /** The method this host should use, decided rather than asked. */
  recommended: "systemd" | "cron" | "container" | "manual";
  recommendedReason: string;
  systemd: UnitState;
  cron: { available: boolean; installed: boolean; line: string | null };
  docker: { available: boolean; enabledAtBoot: boolean | null; detail: string | null };
  pm2: { available: boolean; startupInstalled: boolean; dumpSaved: boolean; detail: string | null };
  /** Panel's own container, when the panel is itself containerised. */
  selfContainer: { id: string | null; restartPolicy: string | null };
  port: { free: boolean; detail: string };
}

function detectContainer(): { containerised: boolean; runtime: string | null } {
  if (process.platform !== "linux") return { containerised: false, runtime: null };
  if (fs.existsSync("/.dockerenv")) return { containerised: true, runtime: "docker" };
  if (fs.existsSync("/run/.containerenv")) return { containerised: true, runtime: "podman" };

  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    const match = cgroup.match(/docker|containerd|kubepods|lxc/);
    if (match) return { containerised: true, runtime: match[0] };
  } catch {
    /* no /proc, so not a Linux container */
  }
  return { containerised: false, runtime: null };
}

function readPid1(): string | null {
  try {
    return fs.readFileSync("/proc/1/comm", "utf8").trim();
  } catch {
    return null;
  }
}

function isWsl(): boolean {
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/**
 * Whether the panel could bind its port.
 *
 * Binding the wildcard, deliberately, because that is what the server does. A
 * probe bound to 127.0.0.1 answers "free" on Windows even while something else
 * holds `0.0.0.0:<port>` — Windows allows a specific address alongside the
 * wildcard — so it would report a port as available that the panel cannot
 * actually take.
 */
async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port);
  });
}

/** Where next's own bin lives, so the unit can name it absolutely. */
export function resolveNextBin(cwd: string): string {
  const candidates = [
    path.join(cwd, "node_modules", "next", "dist", "bin", "next"),
    path.join(cwd, "node_modules", ".bin", "next"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

/**
 * Cached view of `probeAutostart`, for the endpoints that poll it.
 *
 * One probe shells out to systemd, cron, Docker and pm2 and opens a socket, and
 * the autostart page asks every 15 seconds. Install and uninstall call the
 * uncached function directly — they act on what they read, so a stale answer
 * there would be a wrong decision rather than a stale screen — and invalidate
 * this afterwards so the page reflects the change immediately.
 */
export const autostartProbeCache = staleWhileRevalidate(() => probeAutostart(), 30_000);

export async function probeAutostart(): Promise<AutostartProbe> {
  const env = getEnv();
  const container = detectContainer();

  const environment: HostEnvironment = {
    platform: process.platform,
    release: os.release(),
    wsl: isWsl(),
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    root: typeof process.getuid === "function" ? process.getuid() === 0 : false,
    user: os.userInfo().username,
    containerised: container.containerised,
    containerRuntime: container.runtime,
    pid1: readPid1(),
    nodePath: process.execPath,
    workingDirectory: process.cwd(),
    dataDir: config.dataDir,
    port: env.port,
  };

  const [systemd, cron, dockerState, pm2, selfContainer, free] = await Promise.all([
    probeSystemd(environment),
    probeCron(environment),
    probeDocker(environment),
    probePm2(),
    probeSelfContainer(environment),
    portFree(env.port),
  ]);

  const { recommended, reason } = decide(environment, systemd, cron);

  return {
    environment,
    recommended,
    recommendedReason: reason,
    systemd,
    cron,
    docker: dockerState,
    pm2,
    selfContainer,
    port: {
      free,
      detail: free
        ? `La porta ${env.port} è libera`
        : `La porta ${env.port} è occupata — quasi certamente da questo stesso pannello`,
    },
  };
}

/**
 * systemd if PID 1 is systemd and systemctl answers; cron if there is a
 * crontab; otherwise instructions only. Not a question for the operator,
 * because there is a right answer and it is knowable.
 */
function decide(
  environment: HostEnvironment,
  systemd: UnitState,
  cron: { available: boolean }
): { recommended: AutostartProbe["recommended"]; reason: string } {
  if (environment.containerised) {
    return {
      recommended: "container",
      reason:
        "Il pannello gira dentro un container: farlo ripartire è compito di Docker, non di systemd.",
    };
  }
  if (environment.platform !== "linux") {
    return {
      recommended: "manual",
      reason: `L'installazione automatica è supportata solo su Linux (qui: ${environment.platform}).`,
    };
  }
  if (systemd.available && environment.pid1 === "systemd") {
    return {
      recommended: "systemd",
      reason:
        "systemd è il gestore di questa macchina: è l'unico che dà riavvio automatico, ordine dopo Docker e log nel journal.",
    };
  }
  if (cron.available) {
    return {
      recommended: "cron",
      reason:
        "systemd non è disponibile qui, quindi si usa una riga @reboot nel crontab. Funziona, ma senza riavvio automatico nativo.",
    };
  }
  return {
    recommended: "manual",
    reason: "Né systemd né cron sono utilizzabili: l'avvio va configurato a mano.",
  };
}

async function probeSystemd(environment: HostEnvironment): Promise<UnitState> {
  if (environment.platform !== "linux") {
    return {
      available: false,
      installed: false,
      enabled: false,
      active: false,
      fragmentPath: null,
      detail: "Disponibile solo su Linux",
    };
  }

  const version = await run("systemctl", ["--version"]);
  if (!version.ok) {
    return {
      available: false,
      installed: false,
      enabled: false,
      active: false,
      fragmentPath: null,
      detail: "systemctl non è utilizzabile su questa macchina",
    };
  }

  const [enabled, active, show] = await Promise.all([
    run("systemctl", ["is-enabled", UNIT_NAME]),
    run("systemctl", ["is-active", UNIT_NAME]),
    run("systemctl", ["show", "-p", "FragmentPath", UNIT_NAME]),
  ]);

  const fragment = show.stdout.split("=")[1]?.trim() || null;

  return {
    available: true,
    installed: Boolean(fragment),
    // `is-enabled` prints its answer and exits non-zero when the answer is no.
    enabled: enabled.stdout === "enabled",
    active: active.stdout === "active",
    fragmentPath: fragment,
    detail: enabled.stdout || enabled.stderr || null,
  };
}

async function probeCron(
  environment: HostEnvironment
): Promise<{ available: boolean; installed: boolean; line: string | null }> {
  if (environment.platform !== "linux") return { available: false, installed: false, line: null };

  const which = await run("sh", ["-c", "command -v crontab"]);
  if (!which.ok || !which.stdout) return { available: false, installed: false, line: null };

  // Exit 1 means "no crontab for this user", which is a perfectly ordinary
  // state and not a failure.
  const list = await run("crontab", ["-l"]);
  const line =
    list.stdout
      .split("\n")
      .find((entry) => entry.includes("@reboot") && /runpanel/i.test(entry)) ?? null;

  return { available: true, installed: Boolean(line), line };
}

/**
 * Docker's own boot state, which matters as much as the panel's.
 *
 * A unit ordered `After=docker.service` is useless if Docker itself is
 * disabled at boot, and that is a common real state on machines where someone
 * started it by hand once and never thought about it again.
 */
async function probeDocker(
  environment: HostEnvironment
): Promise<{ available: boolean; enabledAtBoot: boolean | null; detail: string | null }> {
  const version = await dockerTry(["version", "--format", "{{.Server.Version}}"], {
    timeout: PROBE_TIMEOUT,
  });

  if (environment.platform !== "linux") {
    return {
      available: version !== null,
      enabledAtBoot: null,
      detail: "L'avvio di Docker al boot si controlla solo su Linux",
    };
  }

  const enabled = await run("systemctl", ["is-enabled", "docker"]);
  return {
    available: version !== null,
    enabledAtBoot: enabled.stdout === "enabled",
    detail: enabled.stdout || enabled.stderr || null,
  };
}

/**
 * PM2 matters on its own account: it runs the user's applications, so if
 * `pm2 save` was never run, none of them come back even when RunPanel does.
 */
async function probePm2(): Promise<{
  available: boolean;
  startupInstalled: boolean;
  dumpSaved: boolean;
  detail: string | null;
}> {
  const list = await run("pm2", ["jlist"]);
  if (!list.ok && !list.stdout) {
    return {
      available: false,
      startupInstalled: false,
      dumpSaved: false,
      detail: "pm2 non è installato o non è nel PATH",
    };
  }

  const dump = path.join(os.homedir(), ".pm2", "dump.pm2");
  let saved = false;
  try {
    saved = fs.existsSync(dump) && fs.statSync(dump).size > 2;
  } catch {
    /* an unreadable home is answer enough */
  }

  const unit = await run("systemctl", ["is-enabled", `pm2-${os.userInfo().username}`]);

  return {
    available: true,
    startupInstalled: unit.stdout === "enabled",
    dumpSaved: saved,
    detail: saved ? null : "Nessuna lista salvata: pm2 resurrect non riporterebbe su nulla",
  };
}

async function probeSelfContainer(
  environment: HostEnvironment
): Promise<{ id: string | null; restartPolicy: string | null }> {
  if (!environment.containerised) return { id: null, restartPolicy: null };

  // Inside a container the hostname is the short container id unless someone
  // overrode it, which is the cheapest identification available.
  const id = process.env.HOSTNAME ?? os.hostname();
  const inspected = await dockerTry(
    ["inspect", "-f", "{{.HostConfig.RestartPolicy.Name}}", id],
    { timeout: PROBE_TIMEOUT }
  );

  return { id, restartPolicy: inspected?.stdout.trim() || null };
}

export interface ContainerPolicy {
  container: string;
  actual: string;
  kind: "project" | "service";
  name: string;
}

/**
 * The restart policy every container RunPanel owns actually has.
 *
 * One `docker inspect` with N ids rather than N calls: this is polled by a page
 * and the per-object cost is the thing that makes such a page expensive.
 */
export async function containerPolicies(): Promise<ContainerPolicy[]> {
  const listed = await dockerTry(
    ["ps", "-a", ...ownedFilters({}), "--format", "{{.Names}}"],
    { timeout: PROBE_TIMEOUT }
  );
  if (!listed) return [];

  const names = lines(listed.stdout);
  if (names.length === 0) return [];

  const inspected = await dockerTry(
    ["inspect", "-f", "{{.Name}}\t{{.HostConfig.RestartPolicy.Name}}", ...names],
    { timeout: 15_000 }
  );
  if (!inspected) return [];

  return lines(inspected.stdout).map((line) => {
    const [rawName, policy] = line.split("\t");
    const container = rawName.replace(/^\//, "");
    const service = container.startsWith("runpanel-svc-");
    return {
      container,
      actual: policy ?? "",
      kind: service ? ("service" as const) : ("project" as const),
      name: service
        ? container.replace(/^runpanel-svc-/, "")
        : container.replace(/^runpanel-/, ""),
    };
  });
}

/** Change one container's restart policy. Offered, never applied on its own. */
export async function setRestartPolicy(container: string, policy: string): Promise<void> {
  await docker(["update", "--restart", policy, container], { timeout: 30_000 });
}
