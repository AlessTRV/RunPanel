[← RunPanel](../../README.md) · [Italiano](../it/domains.md) · **English**

---

# Domains

Every project with a port can be served on a subdomain over HTTPS: `app.example.com` instead of `203.0.113.7:3001`. The panel writes the server blocks for the **nginx** already on the machine and asks **certbot** for a Let's Encrypt certificate per name; the blocks you wrote yourself are never touched.

## What you need

- Linux, with nginx and certbot installed (for instance `sudo apt install nginx certbot`).
- A domain you own, and at its DNS provider **one wildcard record**: `*.example.com` → the server's public address (`A`, plus `AAAA` if it has IPv6). One record covers every subdomain; each name gets its own certificate, so no DNS API is needed.
- Ports 80 and 443 reaching nginx: port 80 is where Let's Encrypt checks the name, for the first certificate and every renewal.

## Setting nginx up

Once per server, from **Sistema › Domini** (it needs the *Accesso all'host* permission):

- **Panel running as root**: press **Configura**.
- **Otherwise**: the page shows the commands to paste in a terminal with sudo, then press **Ho eseguito i comandi**.

The setup adds one file to nginx's configuration, `/etc/nginx/conf.d/runpanel.conf`, which includes `/var/lib/runpanel-proxy/sites/*.conf`. That directory, the certbot webroot and the certificates live under `/var/lib/runpanel-proxy`, owned by the panel's user, so certbot runs without root. Testing and reloading nginx is the only thing that needs root, and the panel gets it in one of three ways:

| How the panel runs | How it reloads nginx |
|---|---|
| as root | it runs `nginx -t` and `nginx -s reload` itself |
| under systemd (RunPanel's own unit included) | it writes a request file; two root path units run `/usr/local/sbin/runpanel-nginx`, which tests and reloads and leaves the outcome in `/run/runpanel-proxy` |
| without systemd | a sudo rule allowing exactly `nginx -t` and `nginx -s reload` |

The systemd route is not a detour: RunPanel's unit sets `NoNewPrivileges=yes`, under which sudo cannot work — and that flag is worth keeping, because it also stops every native project below the panel from ever using sudo.

Deleting `/etc/nginx/conf.d/runpanel.conf` and reloading takes every managed name down at once.

## Giving a project a name

1. In **Sistema › Domini**, add the domain (`example.com`).
2. In the project, **Impostazioni › Dominio**: type the subdomain, choose the domain, **Assegna**.

The panel writes the block, reloads nginx, checks that the name really reaches this server and asks for the certificate in the background: a few seconds later the name reads *HTTPS attivo*. If the request fails, the reason shows under the name (Let's Encrypt's own message, for instance `NXDOMAIN` when the DNS record is missing) with **Richiedi il certificato** to try again.

Certificates are renewed by the panel itself, checking twice a day as certbot does: a renewal happens only within 30 days of expiry, and each name shows its expiry date. Let's Encrypt no longer sends expiry emails, so the address under **Email per Let's Encrypt** is optional: it is only the account's contact.

## How a name reaches the app

nginx forwards to the port the app really listens on, over loopback, with `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` and WebSockets passed through, and a 100 MB body limit. Changing the project's port or its access rules rewrites the block by itself; deleting the project takes its names and their certificates with it.

**Restricted projects.** A name follows the project's [network rules](network.md): nginx allows the same addresses (and this machine) and refuses the rest. To expose a project **only** over HTTPS, restrict its port with an empty list ("this machine only") and tick **Raggiungibile da tutti tramite il nome**: the port stays closed to the outside, the name is open.

## What is refused

- A name already served by another nginx block: nginx would keep only one of the two, and the managed one would win, so the panel leaves it out and says so under the name.
- The panel's own address (**Impostazioni › Pannello › Indirizzo pubblico**).
- A name assigned twice, a project without a port, a domain still in use.

## Limits

- One level of subdomain (`app.example.com`, not `api.app.example.com`) and no apex domain.
- Per server: the wildcard record points at one machine, so with [several servers](multi-server.md) each one has its own domains — `*.s1.example.com`, for instance.
- Unknown names under the wildcard land on nginx's default server. If that is the panel, consider a catch-all block returning `444`.
- The include works where `nginx.conf` loads `/etc/nginx/conf.d/*.conf` inside `http {}`, as Debian, Ubuntu and RHEL do out of the box. With a hand-written `nginx.conf` that does not, add that line yourself.
- With SELinux enforcing (RHEL, Fedora), nginx may be refused access to `/var/lib/runpanel-proxy` until the directory is labelled for it (`semanage fcontext` and `restorecon`).
- Not available when the panel runs in a container, or with `RUNPANEL_DISABLE_SCHEDULERS`, which keeps a test instance away from the host's nginx.
