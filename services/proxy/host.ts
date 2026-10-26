import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { getEnv } from "@/lib/env";
import { staleWhileRevalidate } from "@/lib/stale-cache";
import { toolchainPath, whichSync } from "../env-utils";
import {
  CERTBOT_DIR,
  LETSENCRYPT_DIR,
  NGINX_INCLUDE_PATH,
  PROXY_ROOT,
  REQUESTS_DIR,
  REQUEST_ACTIONS,
  RESULTS_DIR,
  SITES_DIR,
  WEBROOT_DIR,
  http2Syntax,
  parseVerdict,
  pathUnit,
  renderInclude,
  setupCommands,
  type Http2Syntax,
  type ReloadMethod,
  type RequestAction,
} from "./render";

/**
 * What this machine offers for serving domains, and the two tools that do it.
 *
 * Read-only and forgiving like the autostart probe: a missing nginx, a path
 * unit that is not enabled, a certbot that is not installed — each is a fact
 * to show, never an exception that hides the others.
 */

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In the order an operator has to fix them: no point asking for the reload
 * before nginx exists, nor for the include before anything can reload it.
 */
export type ProxyState =
  | "disabled"
  | "unsupported"
  | "no-nginx"
  | "not-configured"
  | "no-reload"
  | "no-certbot"
  | "ready";

export interface ProxyProbe {
  state: ProxyState;
  /** The one sentence the page leads with. */
  detail: string;
  root: boolean;
  user: string;
  reload: ReloadMethod;
  nginx: { path: string | null; version: string | null; http2: Http2Syntax };
  certbot: { path: string | null; version: string | null };
  ipv6: boolean;
  /** What to paste, while the panel cannot do the setup itself. */
  commands: string[] | null;
}

export interface Ran {
  ok: boolean;
  /** stdout and stderr together: nginx writes its verdict to stderr. */
  output: string;
}

/** Run a host command. Never throws; a failure is a result like any other. */
async function run(command: string, args: string[], timeoutMs: number): Promise<Ran> {
  try {
    const { stdout, stderr } = await exec(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, PATH: toolchainPath() },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || (e.message ?? "") };
  }
}

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function containerised(): boolean {
  return fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
}

function systemdIsInit(): boolean {
  try {
    return fs.readFileSync("/proc/1/comm", "utf8").trim() === "systemd";
  } catch {
    return false;
  }
}

function reloadMethod(): ReloadMethod {
  if (isRoot()) return "direct";
  return systemdIsInit() ? "systemd" : "sudo";
}

/** `listen [::]:80` is a fatal `nginx -t` error on a kernel without IPv6. */
function hostHasIpv6(): boolean {
  try {
    return fs.readFileSync("/proc/net/if_inet6", "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The include is in place and the directories it points at are ours to write. */
function isConfigured(method: ReloadMethod): boolean {
  try {
    // Both halves: an include written by hand without the map is a fatal
    // "unknown variable" at the first `nginx -t`.
    const include = fs.readFileSync(NGINX_INCLUDE_PATH, "utf8");
    if (!include.includes(`include ${SITES_DIR}/*.conf;`) || !include.includes("$runpanel_connection_upgrade")) {
      return false;
    }
  } catch {
    return false;
  }
  recoverInterruptedSwap();
  // The root as well: an apply swaps `sites` by renaming it inside the root.
  const dirs = [PROXY_ROOT, SITES_DIR, WEBROOT_DIR, LETSENCRYPT_DIR, ...(method === "systemd" ? [REQUESTS_DIR] : [])];
  return dirs.every(writable);
}

export const STAGED_SITES_DIR = `${SITES_DIR}.next`;
export const PREVIOUS_SITES_DIR = `${SITES_DIR}.prev`;

/**
 * Put `sites` back if the panel stopped halfway through swapping it.
 *
 * Between the two renames of an apply the directory does not exist. nginx
 * would not mind — an include glob that matches nothing is fine — but every
 * name would be gone at the next reload, so the previous set comes back.
 */
export function recoverInterruptedSwap(): void {
  try {
    if (!fs.existsSync(SITES_DIR) && fs.existsSync(PREVIOUS_SITES_DIR)) {
      fs.renameSync(PREVIOUS_SITES_DIR, SITES_DIR);
    }
  } catch {
    /* reported as "not configured" by the check that follows */
  }
}

async function canReload(method: ReloadMethod, nginxPath: string): Promise<boolean> {
  if (method === "direct") return true;
  if (method === "systemd") {
    // `is-active` needs no privileges, and answers once per unit.
    const units = await run("systemctl", ["is-active", ...REQUEST_ACTIONS.map(pathUnit)], 5_000);
    return units.ok && units.output.split(/\s+/).every((state) => state === "active");
  }
  // `-l` with a command asks whether it is allowed, without running it.
  const [test, reload] = await Promise.all([
    run("sudo", ["-n", "-l", nginxPath, "-t"], 5_000),
    run("sudo", ["-n", "-l", nginxPath, "-s", "reload"], 5_000),
  ]);
  return test.ok && reload.ok;
}

function firstLine(text: string): string | null {
  return text.split(/\r?\n/).find(Boolean)?.trim() ?? null;
}

const NOT_READY: Record<ReloadMethod, string> = {
  direct: "",
  systemd: "nginx c'è, ma il pannello non può ancora ricaricarlo: mancano le unit systemd qui sotto.",
  sudo: "nginx c'è, ma il pannello non può ancora ricaricarlo senza password: manca la regola sudo qui sotto.",
};

async function probe(): Promise<ProxyProbe> {
  const root = isRoot();
  const user = os.userInfo().username;
  const method = reloadMethod();
  const base: ProxyProbe = {
    state: "unsupported",
    detail: "",
    root,
    user,
    reload: method,
    nginx: { path: null, version: null, http2: "none" },
    certbot: { path: null, version: null },
    ipv6: false,
    commands: null,
  };

  // A throwaway instance next to a real one must not rewrite the real one's
  // nginx — the same reason the flag keeps the gates down.
  if (getEnv().disableSchedulers) {
    return { ...base, state: "disabled", detail: "Con RUNPANEL_DISABLE_SCHEDULERS il pannello non tocca nginx." };
  }
  if (process.platform !== "linux") {
    return { ...base, detail: "I domini sono gestiti solo su Linux, dove gira nginx." };
  }
  if (containerised()) {
    return { ...base, detail: "Il pannello gira in un container: da qui non può configurare l'nginx dell'host." };
  }

  const nginxPath = whichSync("nginx");
  const certbotPath = whichSync("certbot");
  const [nginxVersion, certbotVersion] = await Promise.all([
    nginxPath ? run(nginxPath, ["-v"], 5_000) : null,
    certbotPath ? run(certbotPath, ["--version"], 15_000) : null,
  ]);

  const found: ProxyProbe = {
    ...base,
    nginx: {
      path: nginxPath,
      version: nginxVersion ? firstLine(nginxVersion.output) : null,
      http2: http2Syntax(nginxVersion?.output ?? null),
    },
    certbot: { path: certbotPath, version: certbotVersion?.ok ? firstLine(certbotVersion.output) : null },
    ipv6: hostHasIpv6(),
  };

  if (!nginxPath) {
    return { ...found, state: "no-nginx", detail: "nginx non è installato su questo server." };
  }

  const commands = setupCommands({
    user,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    nginxPath,
    method,
  });

  if (!isConfigured(method)) {
    return {
      ...found,
      state: "not-configured",
      detail: root
        ? "nginx c'è, ma non include ancora i domini del pannello: premi Configura."
        : "nginx c'è, ma va preparato una volta: incolla i comandi qui sotto in un terminale con sudo.",
      commands,
    };
  }
  if (!(await canReload(method, nginxPath))) {
    return { ...found, state: "no-reload", detail: NOT_READY[method], commands };
  }
  if (!certbotPath) {
    return { ...found, state: "no-certbot", detail: "nginx è pronto, ma senza certbot i sottodomini restano in HTTP." };
  }
  return { ...found, state: "ready", detail: "nginx e certbot sono pronti." };
}

export const proxyProbeCache = staleWhileRevalidate(probe, 30_000);

function mtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Ask the path unit, and wait for its verdict.
 *
 * Applies are serialised, so there is never a second request of the same kind
 * in flight to confuse which verdict answers which; a new verdict is one whose
 * file changed after the request was written.
 */
async function viaSystemd(action: RequestAction): Promise<Ran> {
  const verdict = path.join(RESULTS_DIR, action);
  const before = mtime(verdict);
  fs.writeFileSync(path.join(REQUESTS_DIR, action), `${new Date().toISOString()}\n`);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(150);
    const now = mtime(verdict);
    if (now === null || now === before) continue;
    const parsed = parseVerdict(fs.readFileSync(verdict, "utf8"));
    if (parsed) return parsed;
  }
  return {
    ok: false,
    output: `systemd non ha risposto entro 30 secondi: controlla systemctl status ${pathUnit(action)}.`,
  };
}

/**
 * `nginx -t`, or `nginx -t` and then a reload, as root — however this panel
 * gets to root. The systemd path tests again before reloading; that is the
 * point of asking root rather than trusting the test that came before.
 */
export function nginx(found: ProxyProbe, action: RequestAction): Promise<Ran> {
  const nginxPath = found.nginx.path;
  if (!nginxPath) return Promise.resolve({ ok: false, output: "nginx non trovato" });
  const args = action === "test" ? ["-t"] : ["-s", "reload"];
  switch (found.reload) {
    case "direct":
      return run(nginxPath, args, 30_000);
    case "systemd":
      return viaSystemd(action);
    case "sudo":
      return run("sudo", ["-n", nginxPath, ...args], 30_000);
  }
}

/**
 * certbot as the panel's own user: its directories are under `PROXY_ROOT`, so
 * it needs no root, and a renewal never depends on anything root set up.
 */
export function certbot(found: ProxyProbe, args: string[]): Promise<Ran> {
  if (!found.certbot.path) return Promise.resolve({ ok: false, output: "certbot non trovato" });
  // Let's Encrypt can take a while to look at a challenge; certbot waits.
  return run(found.certbot.path, args, 180_000);
}

export type RootSetup = Ran & {
  /** /etc is read-only to this process — RunPanel's own unit has `ProtectSystem=full`. */
  readOnly?: boolean;
};

/**
 * The setup a root panel can do itself: what `setupCommands` asks for, minus
 * the reload plumbing root does not need.
 *
 * The include goes in last and comes out again if nginx refuses it, so a
 * failed setup leaves the operator's nginx exactly as it was.
 */
export async function setUpAsRoot(found: ProxyProbe): Promise<RootSetup> {
  if (!found.root) return { ok: false, output: "Serve root" };

  for (const dir of [PROXY_ROOT, SITES_DIR, WEBROOT_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
  }
  for (const dir of [LETSENCRYPT_DIR, CERTBOT_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const previous = fs.existsSync(NGINX_INCLUDE_PATH) ? fs.readFileSync(NGINX_INCLUDE_PATH, "utf8") : null;
  try {
    fs.writeFileSync(NGINX_INCLUDE_PATH, renderInclude(), { mode: 0o644 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, output: String(err), readOnly: code === "EROFS" || code === "EACCES" || code === "EPERM" };
  }

  const test = await nginx(found, "test");
  if (!test.ok) {
    if (previous === null) fs.rmSync(NGINX_INCLUDE_PATH, { force: true });
    else fs.writeFileSync(NGINX_INCLUDE_PATH, previous);
    return test;
  }
  return nginx(found, "reload");
}
