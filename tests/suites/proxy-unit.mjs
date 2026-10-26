import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Domains as nginx sees them: which names are accepted, and the exact
 * configuration and commands that come out.
 *
 * This is the boundary between operator text and a file a root process loads,
 * so most checks here are refusals — a name, a rule or a path that would
 * become a directive must never reach the output. The rest pins what a block
 * must contain for a certificate to renew and a restriction to hold.
 *
 * Standalone: `lib/proxy-names.ts` and `services/proxy/render.ts` have no
 * imports, so this runs with no nginx, no certbot and no Linux.
 */
export const meta = { name: "proxy-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("proxy-unit");
  const names = await import(pathToFileURL(join(repoRoot, "lib", "proxy-names.ts")).href);
  const render = await import(pathToFileURL(join(repoRoot, "services", "proxy", "render.ts")).href);
  const { normalizeDomain, normalizeSubdomain, hostnameFor, isHostname } = names;

  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  // --- names -------------------------------------------------------------------
  r.check("a domain is lowercased and loses its trailing dot", normalizeDomain(" Esempio.IT. ") === "esempio.it", String(normalizeDomain(" Esempio.IT. ")));
  r.check("a domain of several labels is accepted", normalizeDomain("clienti.esempio.co.uk") === "clienti.esempio.co.uk");
  r.check("a punycode domain is accepted", normalizeDomain("xn--bcher-kva.it") === "xn--bcher-kva.it");
  for (const bad of ["localhost", "esempio", "*.esempio.it", "http://esempio.it", "esempio.it/x", "es_empio.it", "-esempio.it", "esempio-.it", "esem pio.it", "1.2.3.4", "esempio.it;", "", `${"a".repeat(64)}.it`]) {
    r.check(`the domain ${JSON.stringify(bad)} is refused`, normalizeDomain(bad) === null, String(normalizeDomain(bad)));
  }

  r.check("a subdomain is lowercased", normalizeSubdomain(" App ") === "app");
  r.check("a subdomain may hold hyphens and digits", normalizeSubdomain("api-v2") === "api-v2");
  for (const bad of ["a.b", "-app", "app-", "*", "", "ap p", "app;", "_app"]) {
    r.check(`the subdomain ${JSON.stringify(bad)} is refused`, normalizeSubdomain(bad) === null, String(normalizeSubdomain(bad)));
  }

  r.check("the full name is the two joined", hostnameFor("app", "esempio.it") === "app.esempio.it");
  r.check("a full name past 253 characters is refused", hostnameFor("a".repeat(63), `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.it`) === null);
  r.check("a stored hostname passes the renderer's check", isHostname("app.esempio.it") === true);
  r.check("a bare domain is not a hostname here", isHostname("esempio.it") === false);

  // --- HTTP/2 syntax by nginx version ------------------------------------------------
  const { http2Syntax } = render;
  r.check("Ubuntu 24.04's 1.24 uses the listen parameter", http2Syntax("nginx version: nginx/1.24.0 (Ubuntu)") === "listen");
  r.check("1.25.1 switches to the directive", http2Syntax("nginx version: nginx/1.25.1") === "directive");
  r.check("1.27 uses the directive", http2Syntax("nginx version: nginx/1.27.3") === "directive");
  r.check("an nginx older than HTTP/2 gets none", http2Syntax("nginx version: nginx/1.9.4") === "none");
  r.check("an unreadable version gets none", http2Syntax(null) === "none" && http2Syntax("boh") === "none");

  // --- a block over HTTP ------------------------------------------------------------
  const token = "abcdefghijklmnopqrstuvwx";
  const base = {
    hostname: "app.esempio.it",
    upstreamPort: 3001,
    allow: null,
    certificate: null,
    checkToken: token,
    ipv6: true,
    http2: "directive",
  };
  const plain = render.renderSite(base);
  r.check("it listens on 80, both families", plain.includes("    listen 80;") && plain.includes("    listen [::]:80;"));
  r.check("it names the host", plain.includes("server_name app.esempio.it;"));
  r.check("the challenge is served from the webroot", plain.includes(`root ${render.WEBROOT_DIR};`) && plain.includes("location ^~ /.well-known/acme-challenge/"));
  r.check("the routing check answers the token", plain.includes(`return 200 "${token}";`) && plain.includes(`location = ${render.CHECK_PATH}`));
  r.check("without a certificate the app is served on 80", plain.includes("proxy_pass http://127.0.0.1:3001;"));
  r.check("without a certificate there is no 443", !plain.includes("443"));
  r.check("an open name has no allow list", !plain.includes("allow ") && !plain.includes("deny all"));
  r.check("WebSockets go through", plain.includes("proxy_set_header Upgrade $http_upgrade;") && plain.includes("$runpanel_connection_upgrade"));
  r.check("the forwarded headers are set", plain.includes("X-Forwarded-Proto $scheme") && plain.includes("X-Forwarded-For $proxy_add_x_forwarded_for"));
  r.check("without IPv6 there is no [::] listen", !render.renderSite({ ...base, ipv6: false }).includes("[::]"));

  // --- with a certificate --------------------------------------------------------------
  const certificate = render.certificatePaths("app.esempio.it");
  const tls = render.renderSite({ ...base, certificate });
  // The managed-file comment comes first, then one block per port.
  const [port80, port443] = tls.split("\nserver {").slice(1);
  r.check("the certificate lives under the proxy's own directory", certificate.fullchain.startsWith(`${render.LETSENCRYPT_DIR}/live/app.esempio.it/`));
  r.check("port 80 then only redirects", port80.includes("return 301 https://$host$request_uri;") && !port80.includes("proxy_pass"));
  r.check("port 80 still serves the challenge, so renewals work", port80.includes("/.well-known/acme-challenge/"));
  r.check("443 carries the certificate", port443?.includes(`ssl_certificate ${certificate.fullchain};`) && port443.includes(`ssl_certificate_key ${certificate.privkey};`));
  r.check("443 proxies to the app", port443?.includes("proxy_pass http://127.0.0.1:3001;"));
  r.check("a recent nginx gets http2 on;", tls.includes("    http2 on;") && tls.includes("    listen 443 ssl;"));
  const old = render.renderSite({ ...base, certificate, http2: "listen" });
  r.check("an older nginx gets the listen parameter", old.includes("listen 443 ssl http2;") && !old.includes("http2 on;"));
  const none = render.renderSite({ ...base, certificate, http2: "none" });
  r.check("without HTTP/2 neither appears", !none.includes("http2"));

  // --- restricted ---------------------------------------------------------------------
  const limited = render.renderSite({ ...base, certificate, allow: ["192.168.1.0/24", "fd7a:115c:a1e0::/48"] });
  const [limited80, limited443] = limited.split("\nserver {").slice(1);
  r.check("the allow list is applied on 443", limited443?.includes("allow 192.168.1.0/24;") && limited443.includes("allow fd7a:115c:a1e0::/48;") && limited443.includes("deny all;"));
  r.check("this machine is always allowed", limited443?.includes("allow 127.0.0.1;") && limited443.includes("allow ::1;"));
  r.check("the challenge on 80 is not behind the list", !limited80.includes("deny all;"));
  const onlyHere = render.renderSite({ ...base, allow: [] });
  r.check("an empty list means this machine only", onlyHere.includes("allow 127.0.0.1;") && onlyHere.includes("deny all;") && !/allow \d+\.\d+\.\d+\.\d+\/\d+/.test(onlyHere));

  // --- refusals -------------------------------------------------------------------------
  r.check("a hostname with a semicolon is refused", throws(() => render.renderSite({ ...base, hostname: "app.esempio.it; include /etc/shadow" })));
  r.check("a hostname with a space is refused", throws(() => render.renderSite({ ...base, hostname: "app esempio.it" })));
  r.check("port 0 is refused", throws(() => render.renderSite({ ...base, upstreamPort: 0 })));
  r.check("port 70000 is refused", throws(() => render.renderSite({ ...base, upstreamPort: 70000 })));
  r.check("a fractional port is refused", throws(() => render.renderSite({ ...base, upstreamPort: 1.5 })));
  r.check("a rule with a directive in it is refused", throws(() => render.renderSite({ ...base, allow: ["1.2.3.4/32; allow all"] })));
  r.check("a short token is refused", throws(() => render.renderSite({ ...base, checkToken: "abc" })));
  r.check("a token with a quote is refused", throws(() => render.renderSite({ ...base, checkToken: 'abcdefghijklmnop"; x' })));
  r.check(
    "a certificate outside the proxy's directory is refused",
    throws(() => render.renderSite({ ...base, certificate: { fullchain: "/etc/shadow", privkey: "/etc/shadow" } }))
  );
  r.check("a file name is only made from a valid hostname", throws(() => render.siteFileName("../../etc/x")));
  r.check("the site file is the hostname", render.siteFileName("app.esempio.it") === "app.esempio.it.conf");

  // --- shared files ------------------------------------------------------------------------
  const include = render.renderInclude();
  r.check("the include defines the map under RunPanel's own name", include.includes("map $http_upgrade $runpanel_connection_upgrade"));
  r.check("the include points at the sites", include.includes(`include ${render.SITES_DIR}/*.conf;`));
  r.check("the map comes before any block that uses it", include.indexOf("map $http_upgrade") < include.indexOf("include "));

  // --- sudo ---------------------------------------------------------------------------------
  r.check(
    "sudoers allows exactly test and reload",
    render.renderSudoers("runpanel", "/usr/sbin/nginx") === "runpanel ALL=(root) NOPASSWD: /usr/sbin/nginx -t, /usr/sbin/nginx -s reload\n"
  );
  r.check("a user name with punctuation is refused", throws(() => render.renderSudoers("op,root", "/usr/sbin/nginx")));
  r.check("an nginx path with a space is refused", throws(() => render.renderSudoers("op", "/usr/sbin/nginx -s stop")));

  const setup = (method) => render.setupCommands({ user: "op", uid: 1000, gid: 1000, nginxPath: "/usr/sbin/nginx", method });
  const commands = setup("sudo");
  const sudoersLine = commands.find((c) => c.includes(render.SUDOERS_PATH)) ?? "";
  r.check("the directories belong to the panel's user", commands[0].includes("-o 1000 -g 1000") && commands[0].includes(render.SITES_DIR));
  r.check("the key directory is private", commands[1].includes("-m 0700") && commands[1].includes(render.LETSENCRYPT_DIR));
  r.check("the include goes in through a quoted heredoc", commands.some((c) => c.startsWith(`sudo tee ${render.NGINX_INCLUDE_PATH}`) && c.includes("<<'RUNPANEL_EOF'")));
  r.check("the sudoers file is staged with mktemp", sudoersLine.includes("f=$(mktemp)") && !sudoersLine.includes("/tmp/runpanel"));
  r.check(
    "visudo checks it before it is installed",
    sudoersLine.indexOf("visudo -cf") > -1 && sudoersLine.indexOf("visudo -cf") < sudoersLine.indexOf("install -o root")
  );
  r.check("it is installed 0440 as root", sudoersLine.includes("install -o root -g root -m 0440"));
  r.check("the last step tests before it reloads", commands[commands.length - 1] === "sudo /usr/sbin/nginx -t && sudo /usr/sbin/nginx -s reload");

  // --- systemd, for a panel under its own NoNewPrivileges unit ------------------------------------------
  const viaSystemd = setup("systemd");
  const joined = viaSystemd.join("\n");
  r.check("systemd needs no sudoers rule", !joined.includes(render.SUDOERS_PATH));
  r.check("the requests directory belongs to the panel", viaSystemd[0].includes(render.REQUESTS_DIR) && viaSystemd[0].includes("-o 1000 -g 1000"));
  r.check("the script is installed and made executable", joined.includes(`sudo tee ${render.APPLY_SCRIPT_PATH}`) && joined.includes(`sudo chmod 0755 ${render.APPLY_SCRIPT_PATH}`));
  r.check(
    "both path units are installed and enabled",
    joined.includes("runpanel-nginx-test.path") && joined.includes("enable --now runpanel-nginx-test.path runpanel-nginx-reload.path")
  );
  const direct = setup("direct");
  r.check("a root panel's commands carry no reload plumbing", !direct.join("\n").includes("systemctl") && !direct.join("\n").includes("visudo"));

  const script = render.renderApplyScript("/usr/sbin/nginx");
  r.check("the script tests on test", script.includes('test) { /usr/sbin/nginx -t; echo "exit=$?"; }'));
  r.check("and tests again before it reloads", script.includes("/usr/sbin/nginx -t && /usr/sbin/nginx -s reload"));
  r.check("the verdict lands whole, through a rename", script.includes('mv -f "$dir/reload.tmp" "$dir/reload"') && script.includes(`dir=${render.RESULTS_DIR}`));
  r.check("the script never reads the request file", !script.includes(render.REQUESTS_DIR));
  r.check("any other action is refused", script.includes("*) exit 2 ;;"));
  r.check("a script for an odd nginx path is refused", throws(() => render.renderApplyScript("/usr/sbin/nginx; rm -rf /")));

  const service = render.renderApplyService();
  r.check("the service keeps its verdict after it stops", service.includes("RuntimeDirectoryPreserve=yes") && service.includes("RuntimeDirectory=runpanel-proxy"));
  r.check("the service passes the action through", service.includes(`ExecStart=${render.APPLY_SCRIPT_PATH} %i`) && service.includes("Type=oneshot"));
  const reloadPath = render.renderPathUnit("reload");
  r.check("the path unit watches its own request", reloadPath.includes(`PathChanged=${render.REQUESTS_DIR}/reload`) && reloadPath.includes("Unit=runpanel-nginx@reload.service"));

  r.check("a whole verdict is read", JSON.stringify(render.parseVerdict("nginx: test is successful\nexit=0\n")) === JSON.stringify({ ok: true, output: "nginx: test is successful" }));
  r.check("a failing one says so", render.parseVerdict("nginx: [emerg] unknown directive\nexit=1")?.ok === false);
  r.check("half a verdict is not one", render.parseVerdict("nginx: the configuration") === null);

  const teardown = render.teardownCommands("/usr/sbin/nginx").join("\n");
  r.check("teardown removes what setup added", teardown.includes(render.NGINX_INCLUDE_PATH) && teardown.includes(render.APPLY_SCRIPT_PATH) && teardown.includes(`rm -rf ${render.PROXY_ROOT}`));

  // --- certbot -------------------------------------------------------------------------------
  const issue = render.certbotIssueArgs("app.esempio.it", "op@esempio.it");
  const at = (flag) => issue[issue.indexOf(flag) + 1];
  r.check("certbot uses the webroot", issue[0] === "certonly" && issue.includes("--webroot") && at("-w") === render.WEBROOT_DIR);
  r.check("the certificate is named after the host", at("-d") === "app.esempio.it" && at("--cert-name") === "app.esempio.it");
  r.check("certbot never asks a question", issue.includes("--non-interactive") && issue.includes("--agree-tos"));
  r.check("the email is passed when there is one", at("--email") === "op@esempio.it" && issue.includes("--no-eff-email"));
  r.check("certbot keeps to the proxy's directories", at("--config-dir") === render.LETSENCRYPT_DIR);
  const noEmail = render.certbotIssueArgs("app.esempio.it", null);
  r.check("without an email certbot is told so", noEmail.includes("--register-unsafely-without-email") && !noEmail.includes("--email"));
  r.check("certbot is never given an invalid name", throws(() => render.certbotIssueArgs("--help", null)));
  r.check("renew is non-interactive", render.certbotRenewArgs().slice(0, 2).join(" ") === "renew --non-interactive");
  r.check("delete names the certificate", render.certbotDeleteArgs("app.esempio.it").slice(0, 3).join(" ") === "delete --cert-name app.esempio.it");

  // --- reading the tools' output ------------------------------------------------------------------
  const nginxOutput = [
    'nginx: [warn] conflicting server name "App.esempio.it" on 0.0.0.0:80, ignored',
    'nginx: [warn] conflicting server name "app.esempio.it" on [::]:80, ignored',
    "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok",
  ].join("\n");
  const conflicts = render.conflictingNames(nginxOutput);
  r.check("a conflict is read once, lowercased", conflicts.length === 1 && conflicts[0] === "app.esempio.it", JSON.stringify(conflicts));
  r.check("clean output has no conflicts", render.conflictingNames("nginx: configuration file test is successful").length === 0);

  // The shapes a real nginx (1.28) prints, with the paths it would have on Linux.
  const brokenCert = render.blamedNames(
    `nginx: [emerg] cannot load certificate "${render.LETSENCRYPT_DIR}/live/app.esempio.it/fullchain.pem": PEM_read_bio_X509_AUX() failed (SSL: error:0480006C:PEM routines::no start line)\nnginx: configuration file /etc/nginx/nginx.conf test failed`
  );
  r.check("an unreadable certificate blames its name", brokenCert.certificates.join() === "app.esempio.it" && brokenCert.blocks.length === 0, JSON.stringify(brokenCert));
  const brokenBlock = render.blamedNames(
    `nginx: [emerg] unknown directive "bogus" in ${render.SITES_DIR}/api.esempio.it.conf:4\nnginx: configuration file /etc/nginx/nginx.conf test failed`
  );
  r.check("a broken block blames its name", brokenBlock.blocks.join() === "api.esempio.it" && brokenBlock.certificates.length === 0, JSON.stringify(brokenBlock));
  const theirs = render.blamedNames('nginx: [emerg] unknown directive "bogus" in /etc/nginx/sites-enabled/default:12');
  r.check("an error in the operator's own file blames nothing of ours", theirs.blocks.length === 0 && theirs.certificates.length === 0);
  const warned = render.blamedNames(`nginx: [warn] the "listen ... http2" directive is deprecated in ${render.SITES_DIR}/app.esempio.it.conf:24`);
  r.check("a warning blames nothing", warned.blocks.length === 0);

  const certbotOutput = [
    "Saving debug log to /var/lib/runpanel-proxy/certbot/logs/letsencrypt.log",
    "Requesting a certificate for app.esempio.it",
    "Certbot failed to authenticate some domains (authenticator: webroot).",
    "  Domain: app.esempio.it",
    "  Type:   dns",
    "  Detail: DNS problem: NXDOMAIN looking up A for app.esempio.it",
  ].join("\n");
  const failure = render.certbotFailure(certbotOutput);
  r.check("a certbot failure keeps Let's Encrypt's detail", failure.includes("NXDOMAIN") && !failure.includes("Saving debug log"), failure);
  r.check("without a detail the last lines are kept", render.certbotFailure("a\nb\nc\nd\ne").startsWith("b"));

  return r.result();
}
