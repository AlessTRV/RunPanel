[← RunPanel](../../README.md) · [Italiano](../it/multi-server.md) · **English**

---

# More than one server

A RunPanel can manage other RunPanels. Each install stays complete and autonomous: projects, databases, backups and updates run there, with its own Docker and its own `data/` folder. What is shared is the panel: the accounts are the same everywhere, and every linked server can be seen and driven from any panel.

The set of linked servers is a **cluster**. Nothing has to be reachable from the internet: the servers talk over a private network with signed requests. That network must be encrypted (Tailscale and WireGuard already are) or the servers must sit behind HTTPS: the cluster secret travels when a server is linked and when it is rotated, and the GitHub token and the Telegram bot token travel with the accounts.

## Linking a server

1. On the existing panel: **Sistema › Server › Collega un server** (link a server). The panel issues a token valid for one hour and one use, and shows its own address (from **Impostazioni › Pannello › Indirizzo pubblico**, or the request). The first token also creates the cluster.
2. On the new server: install RunPanel as usual and open its port. On the first-run page choose **Collega a un RunPanel** (link to a RunPanel) instead of creating the owner, and enter the setup token (printed in the log, as always), the panel's address, the link token, a name and the address the panel reaches this server at.
3. Pick the role: **Pannello** (panel) if this server should serve the interface too, **Solo nodo** (node only) if it should only be managed.

The new server contacts the panel, receives the cluster secret and the accounts, and from then on the panel calls it. It shows up at once in **Sistema › Server** with status, version and last contact.

The new server's address is the one the **panel** reaches it at, not your browser's: through an SSH tunnel or `localhost` the link succeeds but the server shows as unreachable (the form warns about it).

Only an install on its first run, with an empty `data/`, can join. A server's projects do not move from one server to another.

## Roles

- **Panel**: serves the interface, accepts the cluster's accounts and manages every server, including linking and revoking others.
- **Node**: no direct access. Whoever opens its port sees "Questo server è gestito da …" (managed by) with links to the panels.

The role is changed from **Sistema › Server** and applies everywhere. A panel that becomes a node closes its open sessions.

## Every server in the panel

A page's server is part of its address (`?server=…`): a link to a project on "or" always opens on "or", whoever opens it. The selector top right (in the menu, on a phone) changes that parameter.

- **Lists of every server.** **Panoramica** (overview), **Progetti**, **Servizi**, **Backup**, **Monitor**, **Diagnostica** and **Aggiornamenti** show every server at once, each row with its server's name; the "Tutti i server" filter narrows them to one. A server that does not answer shows as unreachable and never blocks the list.
- **Overview.** One card per server with CPU, memory, disk, Docker, version, running projects and warnings (disk nearly full, different version, things to fix, update available). Below, projects and services split by server, each with its own folders. The same cards are on **Sistema › Server**.
- **Actions.** Starting a service, running a backup, downloading an archive, applying a diagnostics fix or updating a server always go to the row's server.
- **Creating.** New project, new database, new folder and new backup policy ask which server.
- **Single-server pages.** A project or service page, Autostart, Docker cleanup, Settings and the Activity log are about one server at a time: its name shows in the breadcrumb. A link to a project on another server takes you there by itself.
- The **command palette** (Ctrl+K) searches projects and services on every server, **Telegram notifications** start with the name of the server that sent them, and the update banner says which server has one.

Permissions are the account's on the other server too: whoever may read a project reads it wherever it lives.

These stay with the panel you are using, whatever server is selected: **Accessi › Utenti**, your own account and sessions, the accent colour and the page refresh rate.

## What is shared

Users, permissions and grants are replicated to every server and edited from any panel. Every change is pushed to the others at once, nodes included, and a check every minute repairs whatever did not arrive (a server that was off, for instance). If two servers edit the same account, the more recent change wins. A deleted account leaves a trace for 30 days, so a stale copy cannot bring it back.

The GitHub token and the Telegram bot (token and chat) are shared too: every server clones and notifies with the same credentials, and encrypts them with its own key.

Each server keeps its own: sessions (you sign in on each panel separately), invitation links (they open on the panel that issued them), the activity log, backups and destinations, registries, public address, polling interval, update settings and which notifications to send.

## Diagnosis

**Diagnostica**, next to each server in **Sistema › Server**, asks it who it is and compares: reachable, same secret (the signature is accepted), same cluster, version, clock and accounts in step. A different version is also highlighted in the list. The clock turns red past two and a half minutes of difference; past five, requests are refused because signatures expire.

A node has no panel of its own: its updates are handled from the panel's **Sistema › Aggiornamenti**, which lists every server. Each one shows its version, the commits waiting, **Controlla**, **Aggiorna** and how often it checks by itself (every 1, 6 or 24 hours); the server runs that check on its own and announces it on Telegram under its name. **Controlla tutti** and **Aggiorna tutti** act on every server at once, the panel last. **Dettagli** opens that server's commits and live log. A server that updates restarts by itself and is unreachable for a few seconds; the check never applies anything on its own.

## Revocation and the secret

**Revoca** (revoke) unlinks a server: it is told (if it answers), removed everywhere and becomes independent again, with its copy of the accounts and its projects. A revoked panel keeps its sessions; a node does not.

The revoked server still knows the secret, so revoking offers to **regenerate the secret** (there is also a separate **Rigenera il segreto** button). The remaining servers receive the new one in a request signed with the old, with a second attempt for those that do not answer. The old one stays valid for ten minutes: in that time a server left out can be given the secret with **Reinvia il segreto** (resend the secret, next to the server, or in its diagnosis when the signature is refused). After ten minutes there is no secret in common any more: revoke it and reinstall it with an empty `data/`.

## Security

- Every call between servers carries an HMAC-SHA256 over method, path, body, user and time, keyed with the cluster secret. It is valid for five minutes and **once**: a captured request cannot be replayed or pointed at another route.
- The secret is encrypted at rest on every server and never appears in logs. It travels only when linking and rotating: that is why the network between servers must be encrypted.
- A node does not answer without a signature: its port only shows the "managed by" page.
- Joining the cluster is limited to 10 attempts per 15 minutes, and the token works once.

## Limits

- A user's "invited" state is not replicated: on another panel it shows as "invitation expired" until they set a password.
- A folder belongs to the server it was created on.
