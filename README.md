# RunPanel

Self-hosted deployment panel. Deploy from GitHub, a ZIP or a Dockerfile, with
live build output, provisioned databases and Docker housekeeping that actually
reclaims disk.

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)
![SQLite](https://img.shields.io/badge/SQLite-or_Postgres-003B57?logo=sqlite)
![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker)

## What it does

- **Deploy anything** — Node.js, Docker, static, or a custom runtime with your
  own commands. A repository can describe its own deploy contract in
  `runpanel.json`.
- **Live deploys** — build output streams to the browser while the deploy runs,
  over a single SSE connection per project.
- **Databases on demand** — PostgreSQL, MySQL, Redis and MongoDB provisioned as
  labelled containers with their own volumes, and their connection URL injected
  into the app automatically.
- **Backups that restore** — scheduled dumps of every managed database, of
  RunPanel's own store, and of project configuration and volumes, into a single
  verifiable zip. Restoring is guided from the panel, and takes a safety copy of
  whatever it is about to overwrite first.
- **Comes back after a reboot** — generates and installs the systemd unit (or a
  cron `@reboot` line), checks that Docker itself starts at boot, and brings
  back the projects and services you marked, in order.
- **Restrict a port to the networks you name** — any database or app can be
  limited to specific addresses, with the machine's own networks offered as tick
  boxes and the refused ones listed so you can see who is knocking.
- **Housekeeping** — image retention per project, orphan detection, and volume
  cleanup that asks before destroying data.
- **Two runtimes** — PM2 for native processes, Docker for containers, on equal
  footing.
- **Diagnostics** — one page that says what is wrong with this installation and
  what to press to fix it.

## Requirements

- Node.js 20+
- Docker (for container runtimes, provisioned databases and database backups)
- PM2, for projects with a native runtime (`node`, `static`, `custom`). It is
  **not** vendored: install it globally with `npm i -g pm2`, or keep to the
  Docker runtimes. The Diagnostics page tells you which of the two you are in.

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
shell on the host. A restart issues a new one.

## Configuration

Everything lives in `.env` — see `.env.example` for the annotated version. The
environment is validated at boot, so a mistake fails immediately with a message
rather than on the first request that happens to need it.

```bash
RUNPANEL_SECRET=            # hex, ≥64 chars. Generated at data/.secret if unset
RUNPANEL_DATA_DIR=./data
PORT=3000

RUNPANEL_DB_DRIVER=sqlite   # sqlite (default) | postgres
```

### Using Postgres instead of the local file

```bash
RUNPANEL_DB_DRIVER=postgres
RUNPANEL_DATABASE_URL=postgresql://user:pass@host:5432/runpanel
# ...or discrete credentials: RUNPANEL_PG_HOST / _PORT / _USER / _PASSWORD / _DATABASE
```

The schema and every query are identical on both drivers — the test suite runs
against each to keep it that way.

> None of the `RUNPANEL_*` variables reach the projects you deploy. They are
> stripped from the child environment, because `RUNPANEL_SECRET` is the key your
> projects' own secrets are encrypted with.

## The deploy contract

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

Variables prefixed `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_` or `REACT_APP_` are passed
to the **build** as well as the runtime. Frontends inline those into the client
bundle, so supplying them only at runtime ships the wrong value — or fails a
Dockerfile that asserts on them.

### `runpanel.json`

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
`docker.mounts`, `docker.capAdd`, `docker.network`, `docker.extraHosts` and
`envFile.path`. The rest of the contract describes how to build and run the app,
which is the repository's business; these describe what it may reach outside its
own container, which is yours. Choosing a Docker runtime is a choice for
isolation, and a `runpanel.json` must not be able to hand itself the host. When
one tries, the deploy log names the fields it dropped.

## Architecture

```
app/
  (auth)/login          first-run setup and sign-in
  (panel)/              overview, projects, services, monitor, storage, settings
  api/                  REST handlers; /projects/:id/stream is the SSE channel
lib/
  db/                   Kysely schema, migrations, both dialects
  deploy-contract.ts    the contract, its parser and preflight checks
  ip-access.ts          CIDR matching, and the host's own networks
  hooks/                useProjectStream (SSE), useResource (polling)
services/
  deploy-pipeline.ts    the deploy orchestrator
  deploy-queue.ts       per-project serialisation and coalescing
  access-gate.ts        the TCP gate in front of a restricted port
  docker/               cli, ownership labels, images, volumes, stats, gc
  builders/             node, docker, static, custom
  process-drivers/      pm2 and docker
tests/                  end-to-end suites, one isolated server each
data/                   runtime state (gitignored)
```

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

## Security

- Passwords hashed with bcrypt; sessions are per device and stored as a SHA-256
  of the cookie, so a database copy cannot be replayed
- First-run setup requires the token printed at boot, so an unclaimed panel
  cannot be claimed by whoever arrives first
- Login rate limiting survives a restart, counts atomically, and is keyed on an
  address only where a configured proxy vouches for it
- Every `/api` route is refused without a session by `proxy.ts` before it is
  reached, in addition to each handler's own check
- Project env vars and service credentials encrypted at rest (AES-256-GCM)
- RunPanel's own configuration never reaches deployed projects
- Webhook signatures verified with HMAC-SHA256 and a constant-time compare
- File operations resolve symlinks and are confined to the project; ZIP uploads
  are unpacked in-process, refusing traversal entries and links, capped by both
  archive and decompressed size
- Repository URLs must be public `https://`, and the GitHub token is only ever
  attached to requests to GitHub
- Any published port can be restricted to named networks, in front of a listener
  that is moved to loopback so there is no way around it

### Restricting who can reach a port

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

### Putting it on the internet

Terminate TLS in front of the panel and tell it how many proxies it is behind:

```bash
RUNPANEL_TRUSTED_PROXY_HOPS=1
```

Without it the panel cannot believe any client address — `X-Forwarded-For` is
appended to by each hop, so the first entry is the client's own — and falls back
to a single account-wide login limit. The session cookie is marked `Secure` in
production builds, which browsers only accept over HTTPS or on localhost.

## Backups

A *policy* says what to save, how often, and how much of it to keep. Targets are
selectors rather than fixed lists, so "every database" keeps meaning the ones
that exist when the backup runs — including the service you create tomorrow.

Every dump runs **inside the container it belongs to**, which is the only way to
guarantee the client and the server are the same version: a `pg_dump` a major
behind produces a file `pg_restore` refuses, and produces it without complaining.
RunPanel's own SQLite store is captured with `VACUUM INTO` and then verified with
`PRAGMA integrity_check`, never copied — a copy taken under WAL silently omits
the most recent writes.

The archive is a plain zip with a `manifest.json` and a `checksums.txt` in
`sha256sum -c` format, so it can be verified and unpacked without RunPanel. Env
vars and service credentials inside it are re-encrypted with this panel's key;
including the key itself is a separate, explicit choice.

| | |
|---|---|
| Schedules | five-field cron plus the `@daily` family, in the timezone you pick |
| Retention | count, age and total size, together — the newest good archive is never collected |
| Restore | guided, with an automatic pre-restore backup that aborts the restore if it fails |
| Where | `data/backups/archives/<year>/<month>`, 0600 |

The panel's own store is the one thing not restored live: a file this process
has open cannot be swapped underneath it, so the restored database is staged and
put into service at the next boot, with the previous one kept beside it.

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

## Known gaps

- **Light theme** is not shipped; the token layer is structured for it.
- Port restrictions are enforced by the panel process, so they do not survive it
  being stopped — the port simply closes. A rule set that has to hold with the
  panel down needs a host firewall as well.
- Restoring RunPanel's own **Postgres** store is refused from the panel: the
  archive carries the dump and the exact `pg_restore` command, to be run with
  the panel stopped.

## License

MIT
