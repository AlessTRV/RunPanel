import crypto from "crypto";
import dns from "dns";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb, nowIso } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { listenPort, readAccess } from "@/lib/access-columns";
import { compileRules } from "@/lib/ip-access";
import type { ProjectHostsTable } from "@/lib/db/schema";
import {
  PREVIOUS_SITES_DIR,
  STAGED_SITES_DIR,
  certbot,
  nginx,
  proxyProbeCache,
  recoverInterruptedSwap,
  setUpAsRoot,
  type ProxyProbe,
} from "./host";
import {
  CHECK_PATH,
  SITES_DIR,
  blamedNames,
  certbotDeleteArgs,
  certbotFailure,
  certbotIssueArgs,
  certbotRenewArgs,
  certificatePaths,
  conflictingNames,
  renderSite,
  siteFileName,
  type SiteInput,
} from "./render";

/**
 * Domains, end to end: the store says which names exist, this makes nginx and
 * certbot agree.
 *
 * Every change is applied the same way — render every block from the store,
 * swap the whole directory, `nginx -t`, reload, or put the previous directory
 * back. Nothing is edited in place, so a name that was deleted cannot linger
 * and a half-written file can never be what nginx loads.
 */

export const ACME_EMAIL_SETTING = "proxy_acme_email";

const globalRef = globalThis as typeof globalThis & {
  __runpanelProxyChain?: Promise<unknown>;
  __runpanelProxyIssuing?: Set<string>;
  __runpanelProxyRenewTimer?: NodeJS.Timeout;
  __runpanelProxyRenewFirst?: NodeJS.Timeout;
};

/** certbot only renews what is within 30 days of expiry; twice a day is what its own timer does. */
const RENEW_EVERY_MS = 12 * 60 * 60 * 1000;
const RENEW_FIRST_MS = 5 * 60 * 1000;

const issuing = (globalRef.__runpanelProxyIssuing ??= new Set<string>());

/**
 * One apply at a time. Two overlapping ones would rename the same directory
 * under each other, and the loser's `nginx -t` would test the winner's files.
 */
function serialised<T>(task: () => Promise<T>): Promise<T> {
  const previous = globalRef.__runpanelProxyChain ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  globalRef.__runpanelProxyChain = next.catch(() => undefined);
  return next;
}

export function newCheckToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export function proxyProbe(fresh = false): Promise<ProxyProbe> {
  return proxyProbeCache.get({ fresh });
}

/** Whether nginx can take a configuration. Without certbot it serves HTTP only. */
export function canApply(found: ProxyProbe): boolean {
  return found.state === "ready" || found.state === "no-certbot";
}

export function isIssuing(hostId: string): boolean {
  return issuing.has(hostId);
}

/** One name as the pages show it. */
export function hostView(row: ProjectHostsTable & { project_name?: string }) {
  return {
    id: row.id,
    hostname: row.hostname,
    subdomain: row.subdomain,
    domainId: row.domain_id,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    // A request in flight in this process outranks whatever the row says.
    status: issuing.has(row.id) ? "issuing" : row.status,
    lastError: row.last_error,
    applyError: row.apply_error,
    certExpiresAt: row.cert_expires_at,
    publicAccess: row.public_access === 1,
    createdAt: row.created_at,
  };
}

export type HostView = ReturnType<typeof hostView>;

function lastLines(output: string, count = 3): string {
  return output.split(/\r?\n/).filter(Boolean).slice(-count).join(" ").slice(0, 400);
}

async function loadHosts() {
  const db = await getDb();
  return db
    .selectFrom("project_hosts")
    .innerJoin("projects", "projects.id", "project_hosts.project_id")
    .select([
      "project_hosts.id",
      "project_hosts.hostname",
      "project_hosts.public_access",
      "project_hosts.check_token",
      "project_hosts.status",
      "projects.port",
      "projects.access_mode",
      "projects.access_allow",
      "projects.access_port",
    ])
    .orderBy("project_hosts.hostname")
    .execute();
}

type HostRow = Awaited<ReturnType<typeof loadHosts>>[number];

function certificateOnDisk(hostname: string): { fullchain: string; privkey: string } | null {
  const paths = certificatePaths(hostname);
  return fs.existsSync(paths.fullchain) && fs.existsSync(paths.privkey) ? paths : null;
}

function certificateExpiry(fullchain: string): string | null {
  try {
    return new Date(new crypto.X509Certificate(fs.readFileSync(fullchain)).validTo).toISOString();
  } catch {
    return null;
  }
}

/**
 * The block for one name, or why there is none.
 *
 * The upstream is the app's real listener, not the port the gate holds: nginx
 * talks to it over loopback, which the gate would let through anyway, and
 * going straight there keeps the sites up while the panel restarts. So the
 * allow list has to be nginx's job — otherwise a restricted project would be
 * one domain away from open to everyone.
 */
function siteFor(found: ProxyProbe, row: HostRow, withoutCertificate: boolean): SiteInput | string {
  if (!row.port) return "Il progetto non ha una porta: non c'è niente da servire.";
  const access = readAccess(row);
  const allow =
    access.mode === "restricted" && !row.public_access ? compileRules(access.allow).map((rule) => rule.text) : null;

  return {
    hostname: row.hostname,
    upstreamPort: listenPort(row, row.port),
    allow,
    certificate: withoutCertificate ? null : certificateOnDisk(row.hostname),
    checkToken: row.check_token,
    ipv6: found.ipv6,
    http2: found.nginx.http2,
  };
}

/** Write the new set beside the live one and swap them; the old one stays until committed. */
function stage(files: Map<string, string>): { commit: () => void; rollback: () => void } {
  // Before anything is removed: after a swap cut short, the previous set is the only copy.
  recoverInterruptedSwap();
  fs.rmSync(STAGED_SITES_DIR, { recursive: true, force: true });
  fs.rmSync(PREVIOUS_SITES_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGED_SITES_DIR, { mode: 0o755 });
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(STAGED_SITES_DIR, name), content, { mode: 0o644 });
  }
  fs.renameSync(SITES_DIR, PREVIOUS_SITES_DIR);
  fs.renameSync(STAGED_SITES_DIR, SITES_DIR);

  return {
    commit() {
      fs.rmSync(PREVIOUS_SITES_DIR, { recursive: true, force: true });
    },
    rollback() {
      fs.rmSync(SITES_DIR, { recursive: true, force: true });
      fs.renameSync(PREVIOUS_SITES_DIR, SITES_DIR);
    },
  };
}

export interface ApplyResult {
  ok: boolean;
  message: string;
}

async function writeAndReload(found: ProxyProbe): Promise<ApplyResult> {
  const rows = await loadHosts();
  const ours = new Set(rows.map((row) => row.hostname));
  /** Not served at all, and why. */
  const left = new Map<string, string>();
  /** Served over HTTP only, because nginx could not load the certificate. */
  const httpOnly = new Map<string, string>();

  // Each failed test that nginx blames on one of these names sets that name
  // aside and tries again, so one broken name cannot hold back the rest. A
  // refusal it blames on nothing of ours is the operator's nginx being broken,
  // and nothing gets applied over it.
  for (let attempt = 0; attempt <= rows.length; attempt++) {
    const files = new Map<string, string>();
    for (const row of rows) {
      if (left.has(row.hostname)) continue;
      const site = siteFor(found, row, httpOnly.has(row.hostname));
      if (typeof site === "string") left.set(row.hostname, site);
      else files.set(siteFileName(row.hostname), renderSite(site));
    }

    const swap = stage(files);
    const test = await nginx(found, "test");
    const fresh = (name: string) => ours.has(name) && !left.has(name);
    const conflicts = conflictingNames(test.output).filter(fresh);

    if (test.ok && conflicts.length === 0) {
      const reload = await nginx(found, "reload");
      if (!reload.ok) {
        swap.rollback();
        return { ok: false, message: `nginx non si è ricaricato: ${lastLines(reload.output)}` };
      }
      swap.commit();
      await recordApplied(rows, left, httpOnly);
      return {
        ok: true,
        message: left.size === 0 ? "Configurazione applicata." : `Applicata, tranne ${[...left.keys()].join(", ")}.`,
      };
    }

    swap.rollback();
    const blamed = test.ok ? { blocks: [], certificates: [] } : blamedNames(test.output);
    const certificates = blamed.certificates.filter((name) => fresh(name) && !httpOnly.has(name));
    const blocks = blamed.blocks.filter(fresh);
    if (conflicts.length === 0 && certificates.length === 0 && blocks.length === 0) {
      return { ok: false, message: `nginx ha rifiutato la configurazione: ${lastLines(test.output)}` };
    }

    for (const name of conflicts) {
      left.set(name, "Questo nome lo serve già un'altra configurazione di nginx: toglilo da lì o scegline un altro.");
    }
    for (const name of certificates) {
      httpOnly.set(
        name,
        "nginx non riesce a caricare il certificato di questo nome, quindi è servito in HTTP. Rimuovi il nome e riassegnalo per averne uno nuovo."
      );
    }
    for (const name of blocks) {
      left.set(name, `nginx rifiuta il blocco di questo nome: ${lastLines(test.output, 1)}`);
    }
  }
  return { ok: false, message: "nginx ha rifiutato la configurazione." };
}

/** What the apply did to each name, and the certificate each one has on disk now. */
async function recordApplied(rows: HostRow[], left: Map<string, string>, httpOnly: Map<string, string>): Promise<void> {
  const db = await getDb();
  const now = nowIso();
  for (const row of rows) {
    const reason = left.get(row.hostname) ?? httpOnly.get(row.hostname) ?? null;
    const certificate = reason ? null : certificateOnDisk(row.hostname);
    const update: Partial<ProjectHostsTable> = { apply_error: reason, updated_at: now };
    if (certificate) {
      Object.assign(update, { status: "active", last_error: null, cert_expires_at: certificateExpiry(certificate.fullchain) });
    } else if (row.status === "active") {
      // It was served over HTTPS and its files are gone: it needs a new one.
      Object.assign(update, { status: "pending", cert_expires_at: null });
    }
    await db.updateTable("project_hosts").set(update).where("id", "=", row.id).execute();
  }
}

/** Make nginx serve exactly what the store says. Safe to call after any change. */
export function applyProxy(): Promise<ApplyResult> {
  return serialised(async () => {
    const found = await proxyProbe();
    if (!canApply(found)) return { ok: false, message: found.detail };
    try {
      return await writeAndReload(found);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * Apply after a change elsewhere — a port, an access rule, a deleted project —
 * without making that change wait for, or fail on, nginx.
 */
export function applyProxySoon(): void {
  void applyProxy().then((result) => {
    if (!result.ok) console.warn(`[proxy] ${result.message}`);
  });
}

/**
 * The addresses a wildcard record could point at: this machine's own, minus
 * loopback, private ranges, CGNAT/Tailscale and link-local. Empty behind NAT,
 * where the public address belongs to the router and the page says so.
 */
export function publicAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const a = entry.address.toLowerCase();
      const isPrivate =
        entry.family === "IPv4"
          ? /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a)
          : /^(fe[89ab]|f[cd]|::1$)/.test(a);
      if (!isPrivate && !out.includes(entry.address)) out.push(entry.address);
    }
  }
  return out;
}

export interface RoutingCheck {
  reaches: boolean;
  addresses: string[];
  detail: string;
}

/**
 * Does the name reach this nginx? Asked of the name itself, over HTTP, for the
 * token only this server's block answers — which is the one question the
 * operator has, and works the same behind NAT as on a public address.
 *
 * Only advisory: a server that cannot reach its own public address (NAT
 * without hairpinning) fails this and still gets its certificate, because
 * Let's Encrypt asks from outside.
 */
export async function checkRouting(hostname: string, token: string): Promise<RoutingCheck> {
  let addresses: string[] = [];
  try {
    addresses = (await dns.promises.lookup(hostname, { all: true })).map((entry) => entry.address);
  } catch {
    return { reaches: false, addresses, detail: `${hostname} non risolve: manca il record DNS.` };
  }

  try {
    const res = await fetch(`http://${hostname}${CHECK_PATH}`, {
      signal: AbortSignal.timeout(5_000),
      redirect: "manual",
      cache: "no-store",
    });
    const body = (await res.text()).trim();
    if (res.ok && body === token) {
      return { reaches: true, addresses, detail: `${hostname} arriva a questo server.` };
    }
    return {
      reaches: false,
      addresses,
      detail: `${hostname} risolve a ${addresses.join(", ")}, ma lì risponde un altro server.`,
    };
  } catch {
    return {
      reaches: false,
      addresses,
      detail: `${hostname} risolve a ${addresses.join(", ")}, ma da qui non risponde. Se il server è dietro NAT può essere normale.`,
    };
  }
}

async function setHost(hostId: string, values: Partial<ProjectHostsTable>): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("project_hosts")
    .set({ ...values, updated_at: nowIso() })
    .where("id", "=", hostId)
    .execute();
}

async function issue(hostId: string): Promise<void> {
  const found = await proxyProbe();
  if (found.state !== "ready") {
    await setHost(hostId, { status: "error", last_error: found.detail });
    return;
  }

  const db = await getDb();
  const row = await db.selectFrom("project_hosts").selectAll().where("id", "=", hostId).executeTakeFirst();
  if (!row) return;
  await setHost(hostId, { status: "issuing", last_error: null });

  // The HTTP block has to be live before Let's Encrypt comes for the challenge.
  const applied = await applyProxy();
  const served = await db.selectFrom("project_hosts").select("apply_error").where("id", "=", hostId).executeTakeFirst();
  if (!served) return;
  if (!applied.ok || served.apply_error) {
    await setHost(hostId, { status: "error", last_error: served.apply_error ?? applied.message });
    return;
  }

  const routing = await checkRouting(row.hostname, row.check_token);
  const email = (await getSetting(ACME_EMAIL_SETTING))?.trim() || null;
  const result = await certbot(found, certbotIssueArgs(row.hostname, email));

  const still = await db.selectFrom("project_hosts").select("id").where("id", "=", hostId).executeTakeFirst();
  if (!still) {
    // Deleted while certbot was working: nothing is left to use what it issued.
    if (result.ok) await certbot(found, certbotDeleteArgs(row.hostname));
    return;
  }
  if (!result.ok) {
    const why = certbotFailure(result.output);
    await setHost(hostId, { status: "error", last_error: routing.reaches ? why : `${routing.detail} ${why}` });
    return;
  }

  // Now with the certificate: the same apply writes the HTTPS block and marks it active.
  const withTls = await applyProxy();
  if (!withTls.ok) await setHost(hostId, { status: "error", last_error: withTls.message });
}

/**
 * Ask for a certificate in the background. A request takes seconds to a
 * minute, so the route answers at once and the page follows `status`.
 */
export function issueCertificate(hostId: string): void {
  if (issuing.has(hostId)) return;
  issuing.add(hostId);
  void issue(hostId)
    .catch(async (err) => {
      await setHost(hostId, { status: "error", last_error: err instanceof Error ? err.message : String(err) }).catch(
        () => undefined
      );
    })
    .finally(() => issuing.delete(hostId));
}

/** Every name still waiting for its first certificate — after the proxy is set up, for instance. */
export async function issuePending(): Promise<number> {
  if ((await proxyProbe()).state !== "ready") return 0;
  const db = await getDb();
  const rows = await db.selectFrom("project_hosts").select("id").where("status", "=", "pending").execute();
  for (const row of rows) issueCertificate(row.id);
  return rows.length;
}

/** After a name is deleted: its certificate is of no use to anything else. */
export function forgetCertificate(hostname: string): void {
  void (async () => {
    const found = await proxyProbe();
    if (found.state === "ready" && certificateOnDisk(hostname)) {
      await certbot(found, certbotDeleteArgs(hostname));
    }
  })().catch(() => undefined);
}

export interface SetupResult {
  ok: boolean;
  message: string;
  commands: string[] | null;
}

/** The one-time setup: done here when the panel is root, handed over as commands when not. */
export async function setUpProxy(): Promise<SetupResult> {
  const found = await proxyProbe(true);
  if (found.state === "disabled" || found.state === "unsupported" || found.state === "no-nginx") {
    return { ok: false, message: found.detail, commands: null };
  }
  if (found.state !== "not-configured" && found.state !== "no-reload") {
    return { ok: true, message: "nginx è già configurato.", commands: null };
  }
  if (!found.root) {
    return { ok: false, message: found.detail, commands: found.commands };
  }

  const result = await setUpAsRoot(found);
  await proxyProbe(true);
  if (!result.ok && result.readOnly) {
    return {
      ok: false,
      message: "Il pannello è root ma vede /etc in sola lettura (ProtectSystem nella sua unit): incolla i comandi qui sotto.",
      commands: found.commands,
    };
  }
  if (!result.ok) {
    return { ok: false, message: `nginx ha rifiutato l'include: ${lastLines(result.output)}`, commands: null };
  }
  const applied = await applyProxy();
  return { ok: applied.ok, message: applied.ok ? "nginx è configurato." : applied.message, commands: null };
}

async function renew(): Promise<void> {
  const found = await proxyProbe();
  if (found.state !== "ready") return;
  const db = await getDb();
  const any = await db.selectFrom("project_hosts").select("id").where("status", "=", "active").executeTakeFirst();
  if (!any) return;

  const result = await certbot(found, certbotRenewArgs());
  if (!result.ok) console.warn(`[proxy] Rinnovo dei certificati non riuscito: ${certbotFailure(result.output)}`);
  // Reloads nginx onto whatever was renewed, and reads the new expiries.
  const applied = await applyProxy();
  if (!applied.ok) console.warn(`[proxy] ${applied.message}`);
}

export function startProxyRenewal(): void {
  if (globalRef.__runpanelProxyRenewTimer) return;
  globalRef.__runpanelProxyRenewTimer = setInterval(() => void renew().catch(() => undefined), RENEW_EVERY_MS);
  globalRef.__runpanelProxyRenewTimer.unref?.();
  globalRef.__runpanelProxyRenewFirst = setTimeout(() => void renew().catch(() => undefined), RENEW_FIRST_MS);
  globalRef.__runpanelProxyRenewFirst.unref?.();
}

/**
 * At boot: a request that was running when the panel stopped did not finish,
 * and nginx is brought back to what the store says — a restored backup or a
 * moved data directory may have changed it.
 */
export async function reconcileProxy(): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("project_hosts")
    .set({ status: "error", last_error: "Interrotto da un riavvio del pannello: riprova.", updated_at: nowIso() })
    .where("status", "=", "issuing")
    .execute();

  const found = await proxyProbe();
  if (!canApply(found)) return;
  const result = await applyProxy();
  if (!result.ok) console.warn(`[proxy] ${result.message}`);
}
