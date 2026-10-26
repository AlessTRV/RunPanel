/**
 * The nginx side of domains, as text.
 *
 * Everything here is a pure function of its input, so the suite can check the
 * exact configuration and commands on any machine — no Linux, no nginx, no
 * root, the same arrangement as `services/autostart/render.ts`. No imports, for
 * the same reason as there: the standalone suite loads this file directly.
 *
 * The layout on the host, created once by `setupCommands` (or by the panel
 * itself when it runs as root):
 *
 *   /etc/nginx/conf.d/runpanel.conf    the include, inside nginx's `http {}`
 *   /var/lib/runpanel-proxy/sites/     the server blocks, rewritten on every change
 *   /var/lib/runpanel-proxy/acme/      certbot's webroot, read by nginx's workers
 *   /var/lib/runpanel-proxy/letsencrypt/  certificates and keys, 0700
 *
 * Owned by the panel's user, so certbot runs without root and the panel never
 * edits a file of the operator's: their own server blocks stay theirs, and
 * deleting the include file takes every managed domain down at once.
 *
 * Testing and reloading nginx is the one thing that needs root, and how a
 * panel that is not root gets it depends on what started it — see
 * `ReloadMethod`.
 */

export const PROXY_ROOT = "/var/lib/runpanel-proxy";
export const SITES_DIR = `${PROXY_ROOT}/sites`;
export const WEBROOT_DIR = `${PROXY_ROOT}/acme`;
export const LETSENCRYPT_DIR = `${PROXY_ROOT}/letsencrypt`;
export const CERTBOT_DIR = `${PROXY_ROOT}/certbot`;
/** Where the panel drops a `test` or `reload` file for systemd to act on. */
export const REQUESTS_DIR = `${PROXY_ROOT}/requests`;
/** Where root leaves nginx's verdict: root's own directory, so the panel cannot plant a link there. */
export const RESULTS_DIR = "/run/runpanel-proxy";
export const NGINX_INCLUDE_PATH = "/etc/nginx/conf.d/runpanel.conf";
export const SUDOERS_PATH = "/etc/sudoers.d/runpanel-nginx";
export const APPLY_SCRIPT_PATH = "/usr/local/sbin/runpanel-nginx";
export const APPLY_SERVICE = "runpanel-nginx@.service";
export const REQUEST_ACTIONS = ["test", "reload"] as const;
export type RequestAction = (typeof REQUEST_ACTIONS)[number];
export const pathUnit = (action: RequestAction) => `runpanel-nginx-${action}.path`;
/** Where each host answers its own token, so the panel can tell the name reaches this nginx. */
export const CHECK_PATH = "/.well-known/runpanel-check";
/** certbot's hook for a domain on Cloudflare, rewritten by the panel before every run. */
export const CLOUDFLARE_HOOK_PATH = `${CERTBOT_DIR}/cloudflare-hook.mjs`;
/** How the token reaches the hook: certbot's environment, never a file or its renewal settings. */
export const CLOUDFLARE_TOKEN_ENV = "RUNPANEL_CLOUDFLARE_TOKEN";

/**
 * Where Cloudflare's proxy connects from, as published at
 * https://www.cloudflare.com/ips/ — the only peers whose `CF-Connecting-IP`
 * nginx believes. The header from anyone else is ignored, so a visitor who
 * goes around Cloudflare, straight to this server, cannot choose the address
 * the allow list sees.
 */
export const CLOUDFLARE_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

/**
 * How `nginx -t` and `nginx -s reload` run as root.
 *
 * `direct`   the panel is root.
 * `systemd`  the panel writes a request file and a root path unit runs nginx.
 *            The only way that works under RunPanel's own unit, which sets
 *            `NoNewPrivileges=yes` — and that flag is right to keep: it is what
 *            stops every native project below the panel from ever using sudo.
 * `sudo`     a NOPASSWD rule for exactly those two commands, for a host that
 *            has no systemd to ask.
 */
export type ReloadMethod = "direct" | "systemd" | "sudo";

const MANAGED = "# Managed by RunPanel and rewritten on every change: edit it from the panel.";

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The canonical text `lib/ip-access.ts` stores: an address, a slash, a width. */
const CIDR = /^[0-9a-f.:]+\/\d{1,3}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/;

/** How this nginx switches HTTP/2 on, read from `nginx -v`. */
export type Http2Syntax = "directive" | "listen" | "none";

export function http2Syntax(versionOutput: string | null): Http2Syntax {
  const match = versionOutput?.match(/nginx\/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return "none";
  const [major, minor, patch] = match.slice(1).map(Number);
  const atLeast = (a: number, b: number, c: number) =>
    major !== a ? major > a : minor !== b ? minor > b : patch >= c;

  // `http2 on;` arrived in 1.25.1 and deprecated the listen parameter; the
  // parameter is what every older nginx (Ubuntu 24.04 ships 1.24) understands.
  if (atLeast(1, 25, 1)) return "directive";
  if (atLeast(1, 9, 5)) return "listen";
  return "none";
}

export interface SiteInput {
  hostname: string;
  /** Where the app really listens, on loopback — past the gate, see `listenPort`. */
  upstreamPort: number;
  /**
   * Who may come in through the name. Null is everyone. A list, even an empty
   * one, is those addresses plus this machine — the same rule as the gate.
   */
  allow: readonly string[] | null;
  /** Present once certbot has issued one; until then the name is served over HTTP. */
  certificate: { fullchain: string; privkey: string } | null;
  checkToken: string;
  /** Whether the host has IPv6 at all: `listen [::]:80` fails nginx -t on one that does not. */
  ipv6: boolean;
  http2: Http2Syntax;
  /**
   * The domain is on Cloudflare: behind its proxy every connection comes from
   * Cloudflare, so the visitor's address is read from `CF-Connecting-IP`.
   */
  cloudflare: boolean;
}

/**
 * Refuse anything that is not exactly what the callers validated.
 *
 * Every value here is interpolated into a file a root process loads, so the
 * renderer checks again rather than trusting that each route did: a stray
 * semicolon in a server name is a directive.
 */
function assertSite(input: SiteInput): void {
  if (!HOSTNAME.test(input.hostname)) throw new Error(`Nome non valido per nginx: ${input.hostname}`);
  if (!Number.isInteger(input.upstreamPort) || input.upstreamPort < 1 || input.upstreamPort > 65535) {
    throw new Error(`Porta non valida: ${input.upstreamPort}`);
  }
  for (const rule of input.allow ?? []) {
    if (!CIDR.test(rule)) throw new Error(`Regola non valida per nginx: ${rule}`);
  }
  if (!TOKEN.test(input.checkToken)) throw new Error("Token di verifica non valido");
  if (input.certificate) {
    for (const file of [input.certificate.fullchain, input.certificate.privkey]) {
      if (!SAFE_PATH.test(file) || !file.startsWith(`${LETSENCRYPT_DIR}/`)) {
        throw new Error(`Percorso del certificato non valido: ${file}`);
      }
    }
  }
}

function proxyLocation(input: SiteInput): string[] {
  const rules =
    input.allow === null
      ? []
      : [
          ...input.allow.map((rule) => `        allow ${rule};`),
          // This machine, always — the same exception the gate makes.
          "        allow 127.0.0.1;",
          "        allow ::1;",
          "        deny all;",
        ];

  return [
    "    location / {",
    ...rules,
    `        proxy_pass http://127.0.0.1:${input.upstreamPort};`,
    "        proxy_http_version 1.1;",
    "        proxy_set_header Host $host;",
    "        proxy_set_header X-Real-IP $remote_addr;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    "        proxy_set_header X-Forwarded-Host $host;",
    // WebSockets: without these two the upgrade is dropped at the proxy.
    "        proxy_set_header Upgrade $http_upgrade;",
    "        proxy_set_header Connection $runpanel_connection_upgrade;",
    "        proxy_read_timeout 300s;",
    "        proxy_send_timeout 300s;",
    // nginx's default is 1 MB, which turns the first upload into a 413.
    "        client_max_body_size 100m;",
    "    }",
  ];
}

/**
 * One name's server blocks.
 *
 * Port 80 always exists: it is where Let's Encrypt looks for the challenge and
 * where the panel's routing check lands, and neither is behind the allow list —
 * a restriction must not be able to stop a certificate from renewing. Once a
 * certificate exists, port 80 only redirects and the app moves to 443.
 */
export function renderSite(input: SiteInput): string {
  assertSite(input);
  const v6 = (line: string) => (input.ipv6 ? [line] : []);
  const http2Listen = input.http2 === "listen" ? " http2" : "";
  // Server-wide, so the allow list, the log and the headers the app gets all
  // see the visitor rather than Cloudflare.
  const realIp = input.cloudflare
    ? [...CLOUDFLARE_RANGES.map((range) => `    set_real_ip_from ${range};`), "    real_ip_header CF-Connecting-IP;", ""]
    : [];

  const http = [
    "server {",
    "    listen 80;",
    ...v6("    listen [::]:80;"),
    `    server_name ${input.hostname};`,
    "",
    ...realIp,
    "    location ^~ /.well-known/acme-challenge/ {",
    `        root ${WEBROOT_DIR};`,
    '        default_type "text/plain";',
    "        try_files $uri =404;",
    "    }",
    "",
    `    location = ${CHECK_PATH} {`,
    '        default_type "text/plain";',
    `        return 200 "${input.checkToken}";`,
    "    }",
    "",
    ...(input.certificate
      ? ["    location / {", "        return 301 https://$host$request_uri;", "    }"]
      : proxyLocation(input)),
    "}",
  ];

  const https = input.certificate
    ? [
        "",
        "server {",
        `    listen 443 ssl${http2Listen};`,
        ...v6(`    listen [::]:443 ssl${http2Listen};`),
        ...(input.http2 === "directive" ? ["    http2 on;"] : []),
        `    server_name ${input.hostname};`,
        "",
        ...realIp,
        `    ssl_certificate ${input.certificate.fullchain};`,
        `    ssl_certificate_key ${input.certificate.privkey};`,
        "    ssl_protocols TLSv1.2 TLSv1.3;",
        "",
        ...proxyLocation(input),
        "}",
      ]
    : [];

  return [MANAGED, ...http, ...https, ""].join("\n");
}

/**
 * The one file RunPanel adds to nginx's own configuration.
 *
 * The map every block uses lives here, ahead of the include, rather than in a
 * file of its own among the sites: no file name sorts before every hostname
 * (`0.esempio.it.conf` comes before `00-…`). It is under RunPanel's own name
 * because plenty of setups already define a `$connection_upgrade`, and
 * defining it twice is a fatal `nginx -t` error.
 */
export function renderInclude(): string {
  return [
    "# RunPanel: the domains it manages. Delete this file to take them all down.",
    "map $http_upgrade $runpanel_connection_upgrade {",
    "    default upgrade;",
    "    ''      close;",
    "}",
    `include ${SITES_DIR}/*.conf;`,
    "",
  ].join("\n");
}

export function siteFileName(hostname: string): string {
  if (!HOSTNAME.test(hostname)) throw new Error(`Nome non valido per nginx: ${hostname}`);
  return `${hostname}.conf`;
}

/** Exactly two commands, so the panel's user gains no other way into root. */
export function renderSudoers(user: string, nginxPath: string): string {
  if (!USER.test(user)) throw new Error(`Utente non valido: ${user}`);
  if (!SAFE_PATH.test(nginxPath)) throw new Error(`Percorso di nginx non valido: ${nginxPath}`);
  return `${user} ALL=(root) NOPASSWD: ${nginxPath} -t, ${nginxPath} -s reload\n`;
}

/** Single-quote for /bin/sh, closing and reopening around any quote inside. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * What root runs when the panel asks: `test` checks the configuration, `reload`
 * checks it again and reloads. The verdict goes to `RESULTS_DIR` through a
 * temporary file and a rename, so the panel never reads half of one.
 *
 * It never reads the request file — only its arrival matters — so a request
 * the panel's user replaced with a link to something of root's leaks nothing.
 */
export function renderApplyScript(nginxPath: string): string {
  if (!SAFE_PATH.test(nginxPath)) throw new Error(`Percorso di nginx non valido: ${nginxPath}`);
  return [
    "#!/bin/sh",
    "# Installed by RunPanel and run by runpanel-nginx@.service: never by hand.",
    `dir=${RESULTS_DIR}`,
    'case "$1" in',
    `  test) { ${nginxPath} -t; echo "exit=$?"; } > "$dir/test.tmp" 2>&1 && mv -f "$dir/test.tmp" "$dir/test" ;;`,
    `  reload) { ${nginxPath} -t && ${nginxPath} -s reload; echo "exit=$?"; } > "$dir/reload.tmp" 2>&1 && mv -f "$dir/reload.tmp" "$dir/reload" ;;`,
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n");
}

/**
 * The service the two path units start, one instance per action.
 *
 * `RuntimeDirectoryPreserve` matters: a oneshot stops the moment it is done,
 * and without it systemd would delete the verdict before the panel read it.
 */
export function renderApplyService(): string {
  return [
    "[Unit]",
    "Description=RunPanel: nginx %i, when the panel asks",
    "",
    "[Service]",
    "Type=oneshot",
    "RuntimeDirectory=runpanel-proxy",
    "RuntimeDirectoryMode=0755",
    "RuntimeDirectoryPreserve=yes",
    `ExecStart=${APPLY_SCRIPT_PATH} %i`,
    "",
  ].join("\n");
}

export function renderPathUnit(action: RequestAction): string {
  return [
    "[Unit]",
    `Description=RunPanel: nginx ${action} requests`,
    "",
    "[Path]",
    `PathChanged=${REQUESTS_DIR}/${action}`,
    `Unit=runpanel-nginx@${action}.service`,
    "",
    "[Install]",
    "WantedBy=paths.target",
    "",
  ].join("\n");
}

function teeCommand(path: string, content: string): string {
  return `sudo tee ${path} > /dev/null <<'RUNPANEL_EOF'\n${content}RUNPANEL_EOF`;
}

/**
 * The commands to paste, for a panel that cannot do the setup itself — not
 * root, or root under a unit whose `ProtectSystem=full` makes /etc read-only.
 *
 * The sudoers line, when there is one, is checked with `visudo` before it is
 * installed, not after: a file with a syntax error under `/etc/sudoers.d`
 * disables sudo for the whole machine, and then nothing on this list can be run
 * to undo it. It is staged in a `mktemp` file rather than a fixed name in /tmp,
 * which another local user could have planted as a symlink.
 */
export function setupCommands(input: {
  user: string;
  uid: number;
  gid: number;
  nginxPath: string;
  method: ReloadMethod;
}): string[] {
  const owner = `-o ${input.uid} -g ${input.gid}`;
  const dirs = [PROXY_ROOT, SITES_DIR, WEBROOT_DIR, ...(input.method === "systemd" ? [REQUESTS_DIR] : [])];

  const reload =
    input.method === "systemd"
      ? [
          teeCommand(APPLY_SCRIPT_PATH, renderApplyScript(input.nginxPath)),
          `sudo chmod 0755 ${APPLY_SCRIPT_PATH}`,
          teeCommand(`/etc/systemd/system/${APPLY_SERVICE}`, renderApplyService()),
          ...REQUEST_ACTIONS.map((action) => teeCommand(`/etc/systemd/system/${pathUnit(action)}`, renderPathUnit(action))),
          `sudo systemctl daemon-reload && sudo systemctl enable --now ${REQUEST_ACTIONS.map(pathUnit).join(" ")}`,
        ]
      : input.method === "sudo"
        ? [
            `f=$(mktemp) && printf '%s' ${shellQuote(renderSudoers(input.user, input.nginxPath))} > "$f" && sudo visudo -cf "$f" && sudo install -o root -g root -m 0440 "$f" ${SUDOERS_PATH}; rm -f "$f"`,
          ]
        : [];

  return [
    `sudo install -d ${owner} -m 0755 ${dirs.join(" ")}`,
    `sudo install -d ${owner} -m 0700 ${LETSENCRYPT_DIR} ${CERTBOT_DIR}`,
    teeCommand(NGINX_INCLUDE_PATH, renderInclude()),
    ...reload,
    `sudo ${input.nginxPath} -t && sudo ${input.nginxPath} -s reload`,
  ];
}

/** Undoes `setupCommands`, whichever way it went. The certificates go too. */
export function teardownCommands(nginxPath: string): string[] {
  const units = [...REQUEST_ACTIONS.map(pathUnit)];
  return [
    `sudo systemctl disable --now ${units.join(" ")} 2>/dev/null; true`,
    `sudo rm -f ${NGINX_INCLUDE_PATH} ${SUDOERS_PATH} ${APPLY_SCRIPT_PATH} /etc/systemd/system/${APPLY_SERVICE} ${units.map((u) => `/etc/systemd/system/${u}`).join(" ")}`,
    `sudo ${nginxPath} -t && sudo ${nginxPath} -s reload`,
    `sudo rm -rf ${PROXY_ROOT} ${RESULTS_DIR}`,
  ];
}

/**
 * Read a verdict the apply script left: everything nginx said, then `exit=N`.
 * Null while it is not a whole one.
 */
export function parseVerdict(text: string): { ok: boolean; output: string } | null {
  const match = text.match(/exit=(\d+)\s*$/);
  if (!match) return null;
  return { ok: match[1] === "0", output: text.slice(0, match.index).trim() };
}

/** certbot's state, kept under the proxy's own directory so it never needs root. */
export function certbotDirs(): string[] {
  return ["--config-dir", LETSENCRYPT_DIR, "--work-dir", `${CERTBOT_DIR}/work`, "--logs-dir", `${CERTBOT_DIR}/logs`];
}

/**
 * How Let's Encrypt is shown the name is ours: a file it fetches over port 80,
 * or a TXT record the hook publishes through Cloudflare's API. The second needs
 * neither port 80 nor the name pointing straight at this server, which is what
 * a name behind Cloudflare's proxy is missing.
 */
export type Challenge = "http" | "cloudflare";

/**
 * The hook as certbot runs it, through a shell. `node` by name, found on the
 * PATH the panel gives certbot — which has the panel's own node on it — so an
 * upgraded Node does not leave a dead path behind in the renewal settings.
 */
export function cloudflareHookCommand(phase: "auth" | "cleanup"): string {
  return `node ${CLOUDFLARE_HOOK_PATH} ${phase}`;
}

export function certbotIssueArgs(hostname: string, email: string | null, challenge: Challenge = "http"): string[] {
  if (!HOSTNAME.test(hostname)) throw new Error(`Nome non valido: ${hostname}`);
  const proof =
    challenge === "cloudflare"
      ? [
          "--manual",
          "--preferred-challenges",
          "dns",
          "--manual-auth-hook",
          cloudflareHookCommand("auth"),
          "--manual-cleanup-hook",
          cloudflareHookCommand("cleanup"),
        ]
      : ["--webroot", "-w", WEBROOT_DIR];
  return [
    "certonly",
    ...proof,
    "-d",
    hostname,
    "--cert-name",
    hostname,
    "--non-interactive",
    "--agree-tos",
    "--keep-until-expiring",
    ...(email ? ["--email", email, "--no-eff-email"] : ["--register-unsafely-without-email"]),
    ...certbotDirs(),
  ];
}

export function certbotRenewArgs(): string[] {
  return ["renew", "--non-interactive", ...certbotDirs()];
}

export function certbotDeleteArgs(hostname: string): string[] {
  if (!HOSTNAME.test(hostname)) throw new Error(`Nome non valido: ${hostname}`);
  return ["delete", "--cert-name", hostname, "--non-interactive", ...certbotDirs()];
}

/** Where certbot keeps how a certificate is renewed. */
export function renewalConfPath(hostname: string): string {
  if (!HOSTNAME.test(hostname)) throw new Error(`Nome non valido: ${hostname}`);
  return `${LETSENCRYPT_DIR}/renewal/${hostname}.conf`;
}

/** Which challenge a certificate's renewal settings repeat. */
export function renewalChallenge(conf: string): Challenge {
  return /^\s*authenticator\s*=\s*manual\s*$/m.test(conf) && conf.includes(CLOUDFLARE_HOOK_PATH) ? "cloudflare" : "http";
}

/**
 * The hook certbot runs for a domain on Cloudflare: `auth` publishes the TXT
 * record and waits until Cloudflare's own nameservers give it back, `cleanup`
 * removes it. Plain JavaScript for the node already on the machine, nothing to
 * install — and the panel writes it again before every run, so it is never
 * older than the panel.
 *
 * Its failures are printed after `RunPanel:`, which is what `certbotFailure`
 * looks for: certbot itself would only report Let's Encrypt not finding the
 * record, not why it was never there.
 */
export function renderCloudflareHook(): string {
  return String.raw`// Written by RunPanel before every certbot run, and run by certbot: the DNS-01
// challenge through Cloudflare's API. Do not edit, it is rewritten.
import { promises as dns } from "node:dns";

const CLOUDFLARE = "https://api.cloudflare.com/client/v4";
// Only the suite points this elsewhere, at a stand-in with no DNS behind it.
const api = process.env.RUNPANEL_CLOUDFLARE_API || CLOUDFLARE;
const token = process.env.${CLOUDFLARE_TOKEN_ENV};
const domain = process.env.CERTBOT_DOMAIN;
const value = process.env.CERTBOT_VALIDATION;
const record = "_acme-challenge." + domain;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CloudflareError extends Error {
  constructor(message, codes) {
    super(message);
    this.codes = codes;
  }
}

async function cloudflare(path, init) {
  let res;
  try {
    res = await fetch(api + path, {
      ...init,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error("Cloudflare non risponde (" + err.message + ")");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.success) {
    const errors = (body && body.errors) || [];
    const why = errors.map((e) => e.message).join("; ") || "HTTP " + res.status;
    throw new CloudflareError("Cloudflare ha rifiutato la richiesta: " + why, errors.map((e) => e.code));
  }
  return body.result;
}

// The zone holding the name: the name itself, or its closest parent the token sees.
async function findZone() {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const zones = await cloudflare("/zones?name=" + encodeURIComponent(labels.slice(i).join(".")));
    if (zones.length > 0) return zones[0];
  }
  throw new Error("il token Cloudflare non vede nessuna zona che contenga " + domain);
}

// Let's Encrypt asks Cloudflare's own nameservers, and an answer it gets too
// early is cached against us: wait until they give the value back, then a few
// seconds more for the rest of Cloudflare's network.
async function published(zone) {
  if (api !== CLOUDFLARE) return;
  const servers = [];
  for (const ns of zone.name_servers || []) servers.push(...(await dns.resolve4(ns).catch(() => [])));
  if (servers.length === 0) return sleep(30000);
  const resolver = new dns.Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers(servers);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const rows = await resolver.resolveTxt(record).catch(() => []);
    if (rows.some((chunks) => chunks.join("") === value)) break;
    await sleep(2000);
  }
  await sleep(10000);
}

async function auth() {
  const zone = await findZone();
  try {
    await cloudflare("/zones/" + zone.id + "/dns_records", {
      method: "POST",
      body: JSON.stringify({ type: "TXT", name: record, content: value, ttl: 60 }),
    });
  } catch (err) {
    // 81058: the identical record, left by a run that stopped before its cleanup.
    if (!(err instanceof CloudflareError && err.codes.includes(81058))) throw err;
  }
  await published(zone);
}

async function cleanup() {
  const zone = await findZone();
  const query = "?type=TXT&per_page=100&name=" + encodeURIComponent(record);
  for (const row of await cloudflare("/zones/" + zone.id + "/dns_records" + query)) {
    // Cloudflare may hand TXT content back quoted.
    if (String(row.content).replace(/^"(.*)"$/, "$1") === value) {
      await cloudflare("/zones/" + zone.id + "/dns_records/" + row.id, { method: "DELETE" });
    }
  }
}

try {
  if (!token) throw new Error("manca il token Cloudflare: ricollegalo da Sistema › Domini.");
  if (!domain || !value) throw new Error("certbot non ha passato il nome o il valore da pubblicare.");
  if (process.argv[2] === "auth") await auth();
  else if (process.argv[2] === "cleanup") await cleanup();
  else throw new Error("fase sconosciuta: " + process.argv[2]);
} catch (err) {
  console.error("RunPanel: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
`;
}

export function certificatePaths(hostname: string): { fullchain: string; privkey: string } {
  if (!HOSTNAME.test(hostname)) throw new Error(`Nome non valido: ${hostname}`);
  const dir = `${LETSENCRYPT_DIR}/live/${hostname}`;
  return { fullchain: `${dir}/fullchain.pem`, privkey: `${dir}/privkey.pem` };
}

/**
 * The names `nginx -t` says it ignored because another block already claims
 * them on the same port.
 *
 * Only a warning to nginx, which keeps the first block it read and serves that
 * one. The include sits in `conf.d`, read before `sites-enabled` on Debian, so
 * the first one would be ours: a project could quietly take over a name the
 * operator's own configuration serves — the panel's, for instance.
 */
export function conflictingNames(output: string): string[] {
  const names = new Set<string>();
  for (const match of output.matchAll(/conflicting server name "([^"]+)"/g)) {
    names.add(match[1].toLowerCase());
  }
  return [...names];
}

/**
 * The managed names a failed `nginx -t` points at: a block whose file it
 * quotes, or a certificate it could not load.
 *
 * Only `[emerg]` lines count — warnings quote file names too, and a warning
 * fails nothing. Without this one unreadable certificate would stop every name
 * on the server from being applied, the ones that have nothing wrong included.
 */
export function blamedNames(output: string): { blocks: string[]; certificates: string[] } {
  const blocks = new Set<string>();
  const certificates = new Set<string>();
  const block = new RegExp(`${SITES_DIR}/([a-z0-9.-]+)\\.conf`, "g");
  const certificate = new RegExp(`${LETSENCRYPT_DIR}/live/([a-z0-9.-]+)/`, "g");
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("[emerg]")) continue;
    for (const match of line.matchAll(certificate)) certificates.add(match[1]);
    for (const match of line.matchAll(block)) if (!certificates.has(match[1])) blocks.add(match[1]);
  }
  return { blocks: [...blocks], certificates: [...certificates] };
}

/**
 * The lines of a failed certbot run worth showing.
 *
 * Its output is long and mostly progress; what the operator needs is the
 * `Detail:` line from Let's Encrypt ("DNS problem: NXDOMAIN looking up A for
 * ...") or, failing that, the last lines it printed. A failure of the
 * Cloudflare hook comes first: it is the cause, and Let's Encrypt's "no TXT
 * record found" only the consequence.
 */
export function certbotFailure(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Wherever certbot puts it: older versions print the hook's output inline.
  const hook = [
    ...new Set(lines.filter((line) => line.includes("RunPanel: ")).map((line) => line.slice(line.indexOf("RunPanel: ") + 10))),
  ];
  const detail = lines.filter((line) => /^(Detail|Type|Domain):/i.test(line));
  const picked = hook.length > 0 ? hook : detail.length > 0 ? detail : lines.slice(-4);
  return picked.join(" ").slice(0, 500) || "certbot non ha detto perché";
}
