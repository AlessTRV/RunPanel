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

  const http = [
    "server {",
    "    listen 80;",
    ...v6("    listen [::]:80;"),
    `    server_name ${input.hostname};`,
    "",
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

export function certbotIssueArgs(hostname: string, email: string | null): string[] {
  if (!HOSTNAME.test(hostname)) throw new Error(`Nome non valido: ${hostname}`);
  return [
    "certonly",
    "--webroot",
    "-w",
    WEBROOT_DIR,
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
 * ...") or, failing that, the last lines it printed.
 */
export function certbotFailure(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const detail = lines.filter((line) => /^(Detail|Type|Domain):/i.test(line));
  const picked = detail.length > 0 ? detail : lines.slice(-4);
  return picked.join(" ").slice(0, 500) || "certbot non ha detto perché";
}
