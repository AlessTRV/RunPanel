# RunPanel

[Italiano](README.md) · **English**

Self-hosted deployment panel. Deploy from GitHub, a ZIP or a Dockerfile, with
live build output, provisioned databases and Docker housekeeping that actually
reclaims disk.

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20+-5FA04E?logo=nodedotjs&logoColor=white)

![Docker](https://img.shields.io/badge/Docker-runtime-2496ED?logo=docker&logoColor=white)
![PM2](https://img.shields.io/badge/PM2-runtime-2B037A?logo=pm2&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-store-003B57?logo=sqlite&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-store-4169E1?logo=postgresql&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

---

## Contents

[What it does](#what-it-does) · [Requirements](#requirements) · [Quick start](#quick-start) ·
[Configuration](#configuration) · [Deploying a project](#deploying-a-project) ·
[Databases and services](#databases-and-services) · [Network access](#network-access) ·
[Backups and restore](#backups-and-restore) · [Starting at boot](#starting-at-boot) ·
[Updating the panel](#updating-the-panel) ·
[Telegram notifications](#telegram-notifications) · [Private registries](#private-registries) · [The panel, day to day](#the-panel-day-to-day) ·
[Security](#security) · [Architecture](#architecture) · [Development](#development) ·
[Known gaps](#known-gaps)

---

## What it does

- **Deploy anything** — Node.js, static sites, Docker, Compose, or a custom
  runtime with your own commands. A repository can describe its own deploy
  contract in `runpanel.json`.
- **Live deploys** — build output streams to the browser while the deploy runs,
  over a single SSE connection per project.
- **Go back a version** — pick any commit from the branch's history and deploy
  it. The project holds there, and auto-deploy is suspended rather than quietly
  carrying it forward again.
- **Databases on demand** — PostgreSQL, MySQL, Redis and MongoDB provisioned as
  labelled containers with their own volumes, and their connection URL injected
  into the app through an explicit switch.
- **Backups that restore** — scheduled dumps of the databases, of the panel's own
  store, and of project configuration and volumes, into a single verifiable zip,
  on local disk or an S3-compatible bucket.
- **Comes back after a reboot** — generates and installs the systemd unit (or a
  cron `@reboot` line), checks that Docker itself starts at boot, and brings
  back the projects and services you marked, in order.
- **Restrict a port to the networks you name** — any database or app can be
  limited to specific addresses, with the machine's own networks offered as tick
  boxes.
- **Housekeeping** — image retention per project, orphan detection, and volume
  cleanup that asks before destroying data.
- **Diagnostics** — one page that says what is wrong with this installation and
  what to press to fix it.

## Requirements

| | |
|---|---|
| **Node.js** | 20 or newer |
| **Docker** | for container runtimes, provisioned databases and their backups |
| **PM2** | for projects with a native runtime (`node`, `static`, `custom`) |

PM2 is **not** vendored: install it globally with `npm i -g pm2`, or keep to the
Docker runtimes. The Diagnostics page tells you which of the two you are in, and
what is missing.

The panel runs on Linux, macOS and Windows. Installing it at boot is Linux-only;
platform differences are handled where they matter — starting processes,
detecting binaries, file permissions.

## Quick start

```bash
git clone https://github.com/AlessTRV/RunPanel.git
cd RunPanel
npm install
npm run build
npm start
```

Open `http://localhost:3000`. The first visit asks you to set an admin password,
along with the **setup token** the panel prints to its own log at startup:

```
[RunPanel] Not set up yet. Enter this token on the setup screen:

    3f9c1a...
```

Until a password exists, that endpoint has to be open — the token is what stops
whoever finds the port first from claiming the panel, and an admin here has a
shell on the host. A restart issues a new one, unless you pin it with
`RUNPANEL_SETUP_TOKEN`.

## Configuration

Everything lives in `.env` — see `.env.example` for the annotated version. The
environment is validated at boot, so a mistake fails immediately with a message
rather than on the first request that happens to need it.

| Variable | Default | What it does |
|---|---|---|
| `RUNPANEL_SECRET` | generated at `data/.secret` | Encryption key, hex, ≥64 chars |
| `RUNPANEL_DATA_DIR` | `./data` | Store, repositories, logs, archives |
| `PORT` | `3000` | Panel port |
| `RUNPANEL_DB_DRIVER` | `sqlite` | `sqlite` or `postgres` |
| `RUNPANEL_DB_FILE` | `<data>/runpanel.db` | With `sqlite` only |
| `RUNPANEL_DATABASE_URL` | — | With `postgres` only |
| `RUNPANEL_PG_HOST` `_PORT` `_USER` `_PASSWORD` `_DATABASE` | — | Discrete credentials, instead of the URL |
| `RUNPANEL_PG_SSL` | `disable` | `disable`, `require`, `no-verify` |
| `RUNPANEL_PG_POOL_MAX` | `10` | Maximum pooled connections |
| `RUNPANEL_TRUSTED_PROXY_HOPS` | `0` | How many reverse proxies sit in front — see [Putting it on the internet](#putting-it-on-the-internet) |
| `RUNPANEL_SETUP_TOKEN` | issued at each boot | Pins the first-run token |
| `RUNPANEL_DISABLE_SCHEDULERS` | off | Silences the background timers **and the access gates** |
| `RUNPANEL_DEV_ORIGINS` | — | Extra origins accepted by `next dev` |

> None of the `RUNPANEL_*` variables reach the projects you deploy. They are
> stripped from the child environment, because `RUNPANEL_SECRET` is the key your
> projects' own secrets are encrypted with.

### The store: SQLite or Postgres

```bash
RUNPANEL_DB_DRIVER=postgres
RUNPANEL_DATABASE_URL=postgresql://user:pass@host:5432/runpanel
```

The schema and every query are identical on both drivers — the test suite runs
against each to keep it that way. Migrations are applied at boot, before the
first request arrives.

SQLite is the default and it is fine: it is the case the panel is designed for.
Postgres is for when the store has to live off the machine, or when you want
backups handled by your own infrastructure rather than here.

## Deploying a project

### Sources

- **GitHub** — connect a token on the GitHub page and pick the repository from a
  list, with branches loaded from the API. Or paste a public `https://` URL.
- **ZIP upload** — for code that is not on GitHub. The archive is unpacked
  in-process, refusing traversal entries and links, capped by both archive and
  decompressed size.

### Runtimes and presets

| Runtime | What it does | Who runs it |
|---|---|---|
| `node` | Detects the package manager from the lockfile and uses the scripts | PM2 |
| `static` | Serves a build directory | PM2 |
| `custom` | Only the commands you write — any language | PM2 |
| `docker` | Builds the repository's Dockerfile | Docker |
| `compose` | Runs the stack described by the compose file | Docker |

**Presets** are starting points for a common shape of repository: Dockerfile,
Next.js server, Vite/static SPA, Python (uvicorn/gunicorn), Go. Each carries a
runtime and the commands that go with it.

- At creation the panel detects one by looking at the repository's files, and you
  can pick one by hand for a repository whose shape cannot be seen from outside.
- Under **Settings → Build and start** you can select a preset and press **Apply
  commands**: the three fields are filled with its own, along with the runtime,
  which always travels with them. Nothing is written until you save.

Precedence, lowest first: the detected preset, then the repository's
`runpanel.json`, then whatever you set in the panel.

### The deploy contract

What RunPanel needs to know to deploy a project. The fields are runtime-neutral;
each runtime maps them its own way.

| Field | Docker | PM2 / native |
|---|---|---|
| `buildEnv` | `--build-arg` per entry | environment during install/build |
| `envFile` | written 0600 and mounted read-only | written into the working directory |
| `commands.release` | one-off container before start | one-off command in the repo dir |
| `healthcheck` | probed by RunPanel after start | identical |
| `runtime.restartPolicy` | `--restart` | PM2 `autorestart` |
| `runtime.memory` / `cpus` / `shmSize` | container limits | `max_memory_restart` where applicable |
| `docker.network` / `hostname` / `capAdd` | `docker run` flags | not applicable |

#### `runpanel.json`

A repository can declare how it wants to be deployed:

```json
{
  "version": 1,
  "commands": { "release": "npx prisma migrate deploy" },
  "envFile": { "enabled": true, "path": "/app/.env" },
  "healthcheck": { "path": "/api/health", "startPeriodSec": 45, "timeoutSec": 120 },
  "runtime": { "restartPolicy": "unless-stopped", "memory": "2g" }
}
```

Panel settings win where both specify a value — the operator can see the target
machine, the repository cannot.

Some fields are **panel-only** and are ignored when they come from a repository:
`docker.mounts`, `docker.capAdd`, `docker.network`, `docker.extraHosts`,
`docker.context`, `docker.dockerfile`, `docker.target`, `healthcheck.path`,
`healthcheck.port` and
`envFile.path`. The rest of the contract describes how to build and run the app,
which is the repository's business; these describe what it may reach outside its
own container, which is yours. Choosing a Docker runtime is a choice for
isolation, and a `runpanel.json` must not be able to hand itself the host. When
one tries, the deploy log names the fields it dropped.

### Environment variables

A project's variables are managed on the **Variables** tab and are encrypted at
rest. They are passed to the process or the container and — when `envFile` is
enabled — also written to a file the app can read itself.

Variables prefixed `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_` or `REACT_APP_` are passed
to the **build** as well as the runtime. Frontends inline those into the client
bundle, so supplying them only at runtime ships the wrong value — or fails a
Dockerfile that asserts on them.

### Automatic deploys

Every project has a webhook URL with a secret of its own. With **Auto-deploy**
on, a push to the configured branch starts a deploy. Signatures are verified with
HMAC-SHA256 and a constant-time compare; deliveries, accepted or rejected, stay
in the history with the reason.

With a GitHub account connected the webhook **registers itself**: flipping the
switch creates it on the repository with the URL, the secret, the
`application/json` content type and the `push` event alone already set. None of
the four is a decision — they all follow from the project — and getting one
wrong by hand failed silently. Turning auto-deploy off deactivates the hook
rather than deleting it, so its delivery history on GitHub survives.

The section also says what is wrong: no token, an unrecognised repository, a
panel address GitHub cannot reach, a misconfigured hook, a refused last
delivery. **Send ping** asks GitHub for a real delivery — across DNS, the
firewall, TLS and the signature, which are the parts that actually break.

So the panel knows which address to write into GitHub, set **Public address**
under Account → Preferences. Left empty it is derived from the request, which
holds as long as you open the panel on the same address GitHub reaches it by.

> **Panel only reachable over a VPN or Tailscale?** Then webhooks never arrive:
> GitHub delivers from the internet and is not on your private network. A
> `100.64–100.127.x.x` address is refused outright; a `*.ts.net` MagicDNS name
> is flagged, because it works **only** if you publish it with
> `tailscale funnel`. You do not have to expose anything: use **polling** below.

### Polling, for a panel nothing can reach

A webhook needs GitHub to open a connection *to* this machine, and for a great
many self-hosted installations that cannot happen: behind NAT with no port
forwarded, on a Tailscale or WireGuard network, on a laptop. There is nothing to
configure better there — the delivery fails before it arrives, and nothing shows
up in the panel's logs, because the problem is the direction of the connection.

So the panel can **ask** instead of being told. In the project's settings, under
*Deploy automatico → Come parte il deploy*:

- **Webhook** — GitHub calls on every push and the deploy starts at once.
  Requires a panel reachable from the internet.
- **Polling** — RunPanel reads the branch on a timer and deploys when the commit
  changes. One outbound request, none inbound: it works anywhere with an
  internet connection.

The interval lives under Account → Preferences, from 30 seconds to 30 minutes
(5 minutes by default). An unchanged branch answers `304 Not Modified` thanks to
the ETag, and GitHub does not count 304s against the hourly rate limit — even 30
seconds costs practically nothing. A deploy is delayed by at most one interval.

The first pass after switching **records** the current commit without deploying
it — "deploy what comes next", not "deploy whatever is there now" — and deploys
started this way appear in the history with the `poll` trigger. Choosing polling
deactivates any webhook, since two live transports would deploy the same commit
twice.

The hook stays configurable by hand — the URL and secret are right there — for
repositories the token cannot administer, or a panel with no account connected.

### Going back to a specific commit

The button next to **Deploy** opens the repository's history: pick the branch,
pick the commit, and the project is rebuilt from there. It is for when the commit
that just went out is the one that broke the app, and the alternative is a revert
on GitHub and another push — a fix that needs the repository to cooperate at the
moment production is down.

The choice **holds**. The project stops at that commit: every deploy rebuilds it,
the header says so with a badge, and **auto-deploy is suspended** rather than
carrying the project forward on the next push. Deliveries that arrive meanwhile
stay in the history as ignored, with the reason — a webhook that does not deploy
has to say why. **Back to the latest commit** releases the hold and deploys the
branch head again.

Choosing a different branch here changes the project's branch: from then on it is
the one the webhook and the poller follow. The commit list comes from the GitHub
API, so it wants a connected account; without one, or for a commit older than the
last hundred, there is a field to paste a SHA into.

One warning the panel repeats before going ahead, because it is the only way this
feature breaks an app invisibly: **database migrations do not roll back**. If the
restored version expects an older schema than the one that is there, it may not
start.

### What a deploy actually does

1. **Queue** — deploys of the same project are serialised, and overlapping ones
   are coalesced: a burst of pushes produces one deploy, not six.
2. **Source** — clone or pull the branch, recording the commit; or, when the
   project is held at a commit, restore that one.
3. **Contract** — detected preset, `runpanel.json`, panel settings.
4. **Build** — install and build per runtime, with the output streaming.
5. **Release command** — run once before start, in a throwaway container or in
   the repository directory. If it fails, the new version does not start: it is
   the right place for migrations.
6. **Start** — PM2 or Docker, with the restart policy and limits from the
   contract.
7. **Health check** — RunPanel probes the app until it answers. Without it, an
   app that starts and dies a second later would count as deployed successfully.

**Re-Build** is the variant that cleans first: it removes `node_modules`,
`.next`, `venv` and the like per runtime, then rebuilds from the code already
checked out.

### One-time commands

The contract's commands run on *every* deploy. One-time commands run once, at the
point of the sequence you pick, and then leave the queue: the migration you need
now, a `git submodule update` after changing repository, a permissions fix, a
cache purge. You write them in **Settings → Comandi una tantum**, and while the
queue is not empty the panel says so next to the Deploy button.

| Step | When | Docker | Native and Compose |
|---|---|---|---|
| Before the deploy | Before anything is touched; the old app is still up | host | host |
| After git | New commit on disk, env loaded, nothing installed yet | host | host |
| Before install | Immediately before the dependencies | — | host |
| After install | Dependencies installed, build not run yet | — | host |
| After build | Build succeeded, before the release command | container | host |
| Before start | Old process stopped, new one not started | container | host |
| After start | Process started, health check not passed yet | container | host |
| On success | Health check passed | container | host |

The two steps around the install do not exist under Docker and Compose: there,
install and build are a single `docker build`, and there is no moment between them
to pin anything to. Changing a project's runtime does not delete a command queued
on one of them — it stays, flagged, and the deploy log says why it did not run.

Where a command runs is decided by the step, not by an option: under Docker the
steps after the build use a throwaway container from the freshly built image —
same network, same mounts, same environment, exactly like the release command —
while the two before the build necessarily run on the host, because that image
does not exist yet. Under Compose everything runs on the host: there is no single
image to make a container from, and reaching one service means writing it out
(`docker compose run --rm api sh -c '…'`).

**If one fails, the deploy fails** and the command **stays queued**: fix the cause
and the next deploy retries it, with the attempt count and the last error in view.
Tick *Continua anche se fallisce* and the deploy carries on, consuming the command
anyway and recording it as failed. Whatever succeeds leaves the queue for the
history, with its step, duration and commit; you can empty that by hand, and it
collects itself after 90 days.

One warning about *On success*: a command failing there marks the deploy failed
**even though the app is alive and healthy**. It is the same state a failed health
check produces, and it is deliberate — but it is the one step where "failed" does
not mean "not serving".

**They are not part of the deploy contract, and that is not an oversight.** The
contract is merged with the repository's `runpanel.json`, so a field there would be
arbitrary shell on the host that anyone able to push could run. They live in a
table of their own, where nothing is merged and the only writer is an
authenticated route: a repository cannot reach them, and there is no exception list
to keep in step. It is not a new capability either — `commands.install` and `build`
already run on the host for native runtimes — but it is one only whoever can sign
in to the panel has. Do not put passwords in them: the command ends up in the
deploy log.

Execution is **at least once**, not exactly once: if the panel restarts while a
command is running, that command goes back in the queue and will run again. The
panel would rather repeat a migration than record one as done without knowing, and
it flags interrupted rows instead of hiding them.

## Databases and services

A *service* is a database managed by the panel: a labelled container, with its
own named volume and encrypted credentials.

| Engine | Versions offered |
|---|---|
| PostgreSQL | 18, 17, 16, 15, 14 |
| MySQL | 9, 8 |
| Redis | 8, 7, 6 |
| MongoDB | 8.0, 7.0 |

These are the majors the official image supports today, minus the preview and
short-cadence channels. An existing service is untouched when the list changes:
the version is stored per row and recreations use that one.

### The console

The panel already knows the container name, the user and the password — the
three things you would go and look up before typing `docker exec` on the host.
The console uses them for you, in three modes: the **engine's own client**
already authenticated (`psql`, `mysql`, `redis-cli`, `mongosh`), a **shell**
inside the container, and the container's **log**, live. The log is read-only
and stored nowhere: it exists for as long as you are looking at it.

It is not a terminal emulator, and that is a choice: `docker exec` with stdin on
a pipe cannot allocate a TTY, so it sends one line at a time. It is also why the
flags matter — without `--table` MySQL answers in tab-separated columns instead
of a grid, and without `--force` the first syntax error would end the session.

There is a warning before the first session, and it has to be accepted: from
there you can delete data irreversibly, and the panel keeps no copy.

### Folders shared with the host

Any folder inside the container can appear wherever you want it on the host: the
configuration, the logs, the uploads, the data directory. Several of them, each
one switchable and optionally read-only. It works for services and for
Docker-runtime projects, through the same interface.

**The first time, the panel seeds**, and that is the part that matters. A bind
mount is not a synchronisation, it is a **substitution**: Docker copies nothing
and merges nothing — it takes the host directory and makes it *be* that path
inside the container. Whatever was there is not deleted, it is covered. So
without seeding you would add a bind and see an empty folder, and so would the
service. The panel copies the current content out before mounting; after that
there is nothing to keep in step, because it is the same directory — change one
side and the other changes, sub-folders included, with no restart.

Seeding runs at two speeds. An ordinary folder is a copy. The engine's **data
directory** is the one case where getting it wrong is invisible: `cp` without
`-a` loses ownership and mode, and a Postgres that finds an empty directory
initialises from scratch, works perfectly, and has lost everything. That case
stops the service, copies with the permissions intact, recreates, **asks the
engine whether the databases are still there**, and puts everything back by
itself if they are not.

If the host folder is not empty it stops and says so, with a checkbox to adopt
what is already there rather than copy over it. And taking a bind *off* the data
directory is refused until you confirm: the engine would go back to the volume
it had before, frozen at the moment you added the bind, and come up on older
data without saying a word.

### Where a native project's files live

A project under PM2 has no container, so it has no binds: it has a directory.
From its settings it moves to another disk with everything in it —
`node_modules` and build output included, so it restarts without rebuilding.

A **symlink** stays at the old location, and that is not a detail: twelve places
in the panel build `data/repos/<slug>` from a slug alone, and the absolute paths
already stored in `deployments.artifact_dir` and in the start command point
inside it. The link keeps every one of them resolving without touching any of
them. The original copy is not deleted: it stays until you say so.

### Linking one to a project

A service can be linked to a project, and then it supplies its connection URL in
an environment variable. The link has an **explicit switch**:

- **On**, the injected value wins over a variable you defined by hand, and the
  panel says so in the deploy log.
- **Off**, the project uses its own variables and the panel touches nothing.

The variable's name is editable (`DATABASE_URL` by default, derived from the
type). Two active links in one project cannot answer to the same key: the second
is refused, naming the first and proposing an alternative, instead of silently
overwriting it.

**The host depends on who is connecting**, and the panel shows the right line for
each: a container on the project network reaches the service by container name
and on its *internal* port; everything else — a PM2 process, a container on
bridge, your own `psql` — goes through the port published on the host.

A service can also be **standalone**, with no project: then it injects nothing
and is simply a database you manage from the panel.

### Databases inside a service

One database server holds several. The service page lists them by reading the
engine rather than a list of its own, and lets you create and drop them with the
connection URL ready for each.

## Network access

By default RunPanel publishes a port the way Docker does — `-p 5433:5432`, with
no bind address, on every interface. That is convenient and it means a database
created from the panel answers to everything on the LAN, and to the internet if
the host has a public address.

Switching **Chi può collegarsi** on, for a service or a project, changes that:

- the container is recreated (or the app restarted) publishing on `127.0.0.1`
  and on a port the panel allocates;
- the panel binds the port your clients already know, and forwards only
  connections from the addresses you listed;
- `127.0.0.1` and `::1` are always allowed and cannot be removed — the health
  probe, the backup dumpers and any `psql` on the box come from there.

Rules are single addresses or CIDR ranges, IPv4 or IPv6. The panel reads the
host's own interfaces and offers them as tick boxes, labelled: the LAN, VPN
ranges (Tailscale's `100.64.0.0/10` is recognised, since its interface reports a
useless `/32`), and virtual switches. Whoever gets turned away is listed on the
page with an **Consenti** button, because otherwise a refused connection and a
stopped database look identical from the other end.

Two things worth knowing before turning it on:

- **It fails closed.** The port is held open by the panel process. If the panel
  is not running, the port is shut. For a security control that is the right
  direction to fail, but it is a change: an app's database used to stay
  reachable while the panel was down.
- **An app on the project network is unaffected.** It reaches its database by
  container name on `runpanel-net-<slug>`, which never goes through the gate.
  Traffic arriving via `host.docker.internal` does, which is why the virtual
  subnets are among the suggestions.

Not offered where it could not be honest: a **Compose** project publishes ports
from a file you own and RunPanel will not rewrite it, and a container on
`network: host` has no published port to move. Both say so instead of showing a
switch that would do nothing.

For a native process the panel also passes `HOST`/`HOSTNAME` and, for the CLIs
where the spelling is known, the bind flag. An app that ignores all of it stays
on every interface at the moved port — so the panel checks, and says so on the
page rather than showing a restriction that is not one.

## Backups and restore

A *policy* says what to save, how often, and how much of it to keep.

### What can be saved

| Target | What it covers |
|---|---|
| One service | the database dump, whole or a single database |
| All services | a selector: it covers the one you create tomorrow |
| One project | configuration, volumes, repository — your choice |
| All projects | same rule |
| The panel | RunPanel's own store, with or without the encryption key |

Targets are selectors rather than fixed lists, so "every database" keeps meaning
the ones that exist when the backup runs.

### How they are taken

Every dump runs **inside the container it belongs to**, which is the only way to
guarantee the client and the server are the same version: a `pg_dump` a major
behind produces a file `pg_restore` refuses, and produces it without complaining.
RunPanel's own SQLite store is captured with `VACUUM INTO` and then verified with
`PRAGMA integrity_check`, never copied — a copy taken under WAL silently omits
the most recent writes.

### Where they go

- **Local disk** — `data/backups/archives/<year>/<month>`, mode 0600.
- **S3-compatible** — AWS S3, Cloudflare R2, MinIO, Backblaze B2. SigV4 is signed
  in-house, no SDK. The endpoint accepts `https://` anywhere and `http://` only
  towards a private address: an archive holds every environment variable in the
  panel, and towards the internet TLS is what protects it.

The archive is a plain zip with a `manifest.json` and a `checksums.txt` in
`sha256sum -c` format, so it can be verified and unpacked without RunPanel. Env
vars and service credentials inside it are re-encrypted with this panel's key;
including the key itself is a separate, explicit choice.

### Schedules, retention, restore

| | |
|---|---|
| Schedules | five-field cron plus the `@daily` family, in the timezone you pick |
| Retention | count, age and total size, together — the newest good archive is never collected |
| Restore | guided, with an automatic pre-restore backup that aborts the restore if it fails |

The restore shows what the archive holds and lets you choose entry by entry. The
panel's own store is the one thing not restored live: a file this process has
open cannot be swapped underneath it, so the restored database is staged and put
into service at the next boot, with the previous one kept beside it.

## Starting at boot

The Autostart page reports what this host already does and generates what it
does not: a systemd unit with absolute paths, ordered after `docker.service` and
requiring it, or a supervised `@reboot` script when systemd is not available. If
RunPanel runs as root it installs it; otherwise it renders a single block to
paste. It never runs `systemctl start` — that would put a second panel on the
port next to the running one.

It also checks the things that make autostart useless when they are missing:
whether Docker itself is enabled at boot, and whether `pm2 save` has ever been
run — without it, PM2 brings back nothing after a reboot even when the panel
comes back.

Inside the panel, each project and service has a switch, an order, a delay, and
whether to wait for it to answer before starting the next one. The reconciler
that applies this at boot is a **repair** pass: it waits for Docker's own
restarts to settle and starts only what is still down, and it never triggers a
build.

The generated unit carries `KillMode=process`, which is not a detail: PM2 is
spawned by the panel, so it lands in that unit's cgroup, and with systemd's
default a `systemctl stop runpanel` kills it too, along with every native-runtime
project it supervises. Docker containers are never involved — they belong to
Docker's cgroup. If the unit was installed before this, the Autostart page says
so and reinstalling it is enough.

The status shown in the lists re-checks itself, every half minute and at the end
of the boot reconciliation. It used to be the panel's memory of the last command
it issued rather than the state of the machine: anything that stopped without
going through here — a reboot, a process killed for memory, a `docker stop` from
a shell, the panel itself going down and taking its children with it — left the
green dot on for good. Now the panel looks, and a project can go to **Stopped**
by itself with nobody having stopped it just then: it means it had not been up
for a while. The check starts nothing and stops nothing, and before calling
something stopped that claimed to be running it waits for two readings that
agree, so a `pm2` that fails to answer for an instant does not paint the whole
panel red.

## Updating the panel

RunPanel is installed by cloning it, so the directory it runs from is a git
working tree — which is all it needs to know whether a newer version exists, and
also *which* version this is. The version shown reads `v0.1.0+125`: the number
after the `+` is the mainline commit count
(`git rev-list --count --first-parent`), which climbs on its own and cannot be
forgotten, while `package.json`'s `0.1.0` has never moved. On a shallow checkout
the count means nothing and the panel shows the SHA instead.
Every six hours, and the interval is a setting on the page, it runs a `git fetch`
against its own remote and compares: outbound only, exactly as for a project, and
no token at all for a public repository. When the branch has moved a strip appears at
the top of every page with the number of commits and an **Aggiorna** button; the
Updates page lists the commits, so pressing that button is a decision rather than
an act of faith.

The check **never applies anything by itself**. That is the deliberate difference
from a project's auto-deploy: somebody who turns auto-deploy on has asked for
their own code to be rebuilt, and nobody asks for the thing they are currently
looking at to restart underneath them.

Once pressed, the panel copies its store, fetches, aligns the checkout, installs
dependencies, builds and restarts. Two details are worth knowing:

- **The build does not go into `.next`.** `next build` empties and rewrites its
  output directory, and the running panel reads from there on every request:
  building in place would break the page showing the progress, and a build that
  failed halfway would leave a panel that cannot start. The new version is built
  in `.next-update` and takes the place of the live one with two renames, only
  after it has been verified. The previous build stays in `.next-old` until the
  next boot.
- **The restart is an exit.** The panel exits with code 75 and whatever already
  supervises it brings it back: systemd with `Restart=always`, or the loop in the
  `@reboot` script. No `systemctl`, no privileges. `KillMode=process` guarantees
  PM2, native projects and containers are left alone.

If anything fails before the swap, the checkout is reset to the commit it started
from and dependencies are reinstalled: `.next` was never touched, so the panel
carries on running the previous version without noticing.

An update is refused when the panel is not a git checkout, when HEAD is detached,
when it runs inside a container — there the change would live in the writable
layer and vanish the first time the container is recreated, so the route is to
rebuild the image — and on Windows, where a build directory cannot be renamed
while the process holds it open. With no supervisor at all the update is still
fetched and built, but stops **before** the swap and hands over the two commands
to run: a build swapped under a process that keeps running would not work.

Uncommitted local changes are discarded (`git reset --hard` followed by
`git clean -fd`), and that is necessary: `lib/icons.generated.ts` is tracked and
`prebuild` regenerates it, so an installation's tree is dirty after every build.
The clean runs without `-x`, so nothing ignored is touched — `data/`,
`node_modules/`, `.next` — and `.env*` files are excluded explicitly. Whatever is
about to be removed is listed in the log before it is removed.

Before starting, the panel takes a copy of its own store with `VACUUM INTO` and
writes the path into the log: migrations run by themselves at boot, and a
migration that fails leaves a panel that is down, which means there is no UI left
to fix it from. An update is refused while a deploy or a backup is running,
because the restart would cut either in half.

Should the panel not come back, the commands to put the previous version back are
in two places that need no working panel: printed to the journal immediately
before the exit, and in `<dataDir>/panel-update.json`.

## Telegram notifications

The panel can tell you when something happens that you would want to know about
without having the panel open. It is set up under **Impostazioni → Notifiche
Telegram**: create a bot with `@BotFather`, paste the token, send your bot any
message, and press **Rileva** — the panel asks Telegram who has written to it and
offers the list, so the chat id is not something you have to go and find
elsewhere.

Telegram is the channel for the same reason the periodic repository check exists:
**the panel only ever dials out**. It does not need to be reachable from the
internet, which is true of a great many self-hosted installations — behind NAT,
on a Tailscale network, on a laptop. The price is that the bot cannot be talked
to: there are no commands, it only sends.

The token is encrypted at rest like the GitHub one and never comes back out of
this page: the screen only learns whether one exists.

### What gets announced

| Event | When |
|---|---|
| **Project or service stopped** | The process is gone and it was not the panel that stopped it |
| **Docker unreachable** | The daemon stopped answering, and again when it comes back |
| **Deploy finished** | Always for automatic deploys; for manual ones only on failure |
| **Backup finished** | Success, partial or failure, with artefacts, size and duration |
| **Update available** | The periodic check found new commits on RunPanel |
| **The panel restarted** | After a reboot or an update |
| **Disk space** | Below 10% free on the data directory, and when it recovers |

Each one has its own switch: a noisy one can be silenced without losing the rest.

Crashes come from the same pass that keeps the status column honest
(`services/status-reconcile.ts`), which is the only place in the panel that
learns a process went away *without being asked to*. They are already confirmed
across two readings, so a `pm2` that fails to answer for a moment sends nothing.

A manual deploy that succeeded is not announced, and that is deliberate: you are
already watching it, with the log streaming. A manual deploy that failed is,
because by then you have probably closed the tab.

### Why it does not bury you

Everything is **edge-triggered**: the crossing counts, not the state. "The disk
is at 8%" would be true every five minutes for a week; what gets announced is the
moment it crossed in, and later the moment it came back out. The disk threshold
carries two points of hysteresis, because a disk that is filling up sits exactly
on the threshold, and that is where a monitor without hysteresis starts
alternating alarm and all-clear forever.

On top of that there is a fifteen-minute silence per event and per subject: a
project under a restart policy that crash-loops would be reported on every sweep,
and the first message already says everything the twentieth would. Per subject
rather than globally, so one project flapping does not hide another falling over
at the same moment.

A panel update is announced when the target commit changes, not while an update
exists: the check runs every six hours and an unapplied update stays unapplied,
so the latter would be four messages a day about the same piece of news.

### When a notification cannot be sent

Nothing happens. `notify()` never throws, never blocks its caller and never makes
anything wait: a deploy does not fail because Telegram did not answer. A failed
send lands in the panel's log with the reason, translated where Telegram is
particularly cryptic — `chat not found` usually means you have not written to the
bot yet, and until you do, a bot cannot write to you.

## Private registries

Docker registry credentials are entered from the panel, encrypted at rest and
written back into Docker's configuration at boot — the data directory can outlive
a container rebuild, and a missing auth file shows up as a `pull access denied`
that tells you nothing useful.

## The panel, day to day

| Page | What it is for |
|---|---|
| **Overview** | the state of everything, on one screen |
| **Projects** | deploys, live logs, history, variables, files, terminal, settings |
| **Services** | managed databases, the databases inside them, project links |
| **Monitor** | CPU, memory, load, uptime of the host and the containers |
| **Storage** | what is using the disk: images, volumes, archives, repositories |
| **Backups** | policies, runs, archives, restores |
| **Autostart** | what comes back after a reboot |
| **Updates** | the panel's version, the commits waiting, the button that applies them |
| **Diagnostics** | what this installation is missing and what to press |
| **GitHub** | token, repositories, branches |
| **Account** | password, per-device sessions, Telegram notifications, preferences |

Details worth knowing:

- **Terminal** — a real shell on the project directory or inside its container,
  with idle sessions reaped automatically.
- **Files** — a browser confined to the project directory, resolving symlinks
  before opening anything.
- **Logs** — live over SSE while the deploy runs, and on file afterwards.
- **Sessions** — one per device, revocable individually from the account page.
- **Preferences** — refresh interval (2, 5, 10 seconds), timezone, five accent
  themes.
- **Command palette** and keyboard navigation; on mobile a bottom bar and a
  drawer that comes in from the right.

## Security

- Passwords hashed with bcrypt; sessions are per device and stored as a SHA-256
  of the cookie, so a database copy cannot be replayed
- First-run setup requires the token printed at boot, so an unclaimed panel
  cannot be claimed by whoever arrives first
- Login rate limiting survives a restart, counts atomically, and is keyed on an
  address only where a configured proxy vouches for it
- Every `/api` route is refused without a session by `proxy.ts` before it is
  reached, in addition to each handler's own check
- Project env vars, service credentials and registry credentials encrypted at
  rest (AES-256-GCM)
- RunPanel's own configuration never reaches deployed projects
- Webhook signatures verified with HMAC-SHA256 and a constant-time compare
- File operations resolve symlinks and are confined to the project; ZIP uploads
  are unpacked in-process, refusing traversal entries and links, capped by both
  archive and decompressed size
- Repository URLs must be public `https://`, and the GitHub token is only ever
  attached to requests to GitHub
- External commands always go through an argv array, never a shell string
- Any published port can be restricted to named networks, in front of a listener
  that is moved to loopback so there is no way around it

### Putting it on the internet

Terminate TLS in front of the panel and tell it how many proxies it is behind:

```bash
RUNPANEL_TRUSTED_PROXY_HOPS=1
```

Without it the panel cannot believe any client address — `X-Forwarded-For` is
appended to by each hop, so the first entry is the client's own — and falls back
to a single account-wide login limit. The session cookie is marked `Secure` in
production builds, which browsers only accept over HTTPS or on localhost.

## Architecture

```
app/
  (auth)/login          first-run setup and sign-in
  (panel)/              overview, projects, services, monitor, storage, backups, settings
  api/                  REST handlers; /projects/:id/stream is the SSE channel
lib/
  db/                   Kysely schema, migrations, both dialects
  deploy-contract.ts    the contract, its parser and preflight checks
  deploy-phases.ts      the eight points a one-time command can pin to
  ip-access.ts          CIDR matching, and the host's own networks
  service-versions.ts   which engine versions are offered
  hooks/                useProjectStream (SSE), useResource (polling)
services/
  deploy-pipeline.ts    the deploy orchestrator
  one-time-commands.ts  the one-time queue: claim, run, outcome, history
  deploy-queue.ts       per-project serialisation and coalescing
  access-gate.ts        the TCP gate in front of a restricted port
  backup/               policies, dumps, archives, destinations, restore
  autostart/            probing, unit generation, reconciliation
  panel-update/         the check, the staged build, the swap, the exit
  notify/               events, message text, the Telegram bot, the host watch
  docker/               cli, ownership labels, images, volumes, stats, gc
  builders/             node, docker, static, compose, custom
  process-drivers/      pm2, docker, compose
  service-templates/    postgresql, mysql, redis, mongodb
tests/                  end-to-end suites, one isolated server each
data/                   runtime state (gitignored)
```

Every `/api` route requires a session, except sign-in and the webhooks. The only
surfaces meant for the outside are the per-project GitHub webhook and the SSE
channels, which still require the session.

## Development

```bash
npm run dev        # dev server
npm run typecheck
npm run lint
npm test           # full suite
npm run test:quick # skip the Docker suites
```

The runner reports what the machine can do and skips the rest rather than
failing: suites needing a Docker daemon, and the native-runtime suite needing a
real PM2 (`npm i -g pm2`). Both are listed as `SKIP` in the summary, so a green
run never hides untested ground.

Each suite gets a server of its own on a temporary data directory. Some are
*standalone*: they load the module under test directly, with no server and no
daemon, and cover the pure rules — CIDR matching, the deploy contract, SigV4
signing, variable injection, engine versions.

Postgres suites need a database:

```bash
docker run -d --name rp-test-pg -e POSTGRES_PASSWORD=test \
  -e POSTGRES_USER=runpanel -e POSTGRES_DB=runpanel_test \
  -p 55432:5432 postgres:18-alpine

RUNPANEL_TEST_PG_URL=postgresql://runpanel:test@127.0.0.1:55432/runpanel_test npm test
```

Icons are bundled from a generated subset. After adding one, `npm run icons` —
though `predev` and `prebuild` run it for you, and the build fails on an icon
name that does not exist.

## Known gaps

- One-time commands run **at least once**, not exactly once: a panel restart
  mid-execution puts the command back in the queue.
- **Light theme** is not shipped; the token layer is structured for it.
- Port restrictions are enforced by the panel process, so they do not survive it
  being stopped — the port simply closes. A rule set that has to hold with the
  panel down needs a host firewall as well.
- Restoring RunPanel's own **Postgres** store is refused from the panel: the
  archive carries the dump and the exact `pg_restore` command, to be run with
  the panel stopped.
- Restore does not compare versions: a dump taken on one major and restored onto
  another is accepted and fails partway, with the safety copy already taken.
- Installing at boot is **Linux-only**; elsewhere the panel shows what to do by
  hand.
- **Notifications** have one channel, Telegram, and go to one chat. The bot
  takes no commands: the panel talks, it does not listen.
- **Updating the panel from the panel** needs something that will start it
  again after it exits: systemd, or the `@reboot` script. Without one the new
  version is still built, but the swap and the restart stay two commands to run
  by hand. Inside a container and on Windows it is not available at all.

## License

MIT
