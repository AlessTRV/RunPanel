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
- **Housekeeping** — image retention per project, orphan detection, and volume
  cleanup that asks before destroying data.
- **Two runtimes** — PM2 for native processes, Docker for containers, on equal
  footing.

## Requirements

- Node.js 20+
- Docker (for container runtimes and provisioned databases)
- PM2 is installed as a dependency; no global install needed

## Quick start

```bash
git clone https://github.com/AlessTRV/RunPanel.git
cd RunPanel
npm install
npm run build
npm start
```

Open `http://localhost:3000`. The first visit asks you to set an admin password.

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

## Architecture

```
app/
  (auth)/login          first-run setup and sign-in
  (panel)/              overview, projects, services, monitor, storage, settings
  api/                  REST handlers; /projects/:id/stream is the SSE channel
lib/
  db/                   Kysely schema, migrations, both dialects
  deploy-contract.ts    the contract, its parser and preflight checks
  hooks/                useProjectStream (SSE), useResource (polling)
services/
  deploy-pipeline.ts    the deploy orchestrator
  deploy-queue.ts       per-project serialisation and coalescing
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
npm test           # full suite; needs Docker
npm run test:quick # skip the Docker suites
```

Postgres suites need a database:

```bash
docker run -d --name rp-test-pg -e POSTGRES_PASSWORD=test \
  -e POSTGRES_USER=runpanel -e POSTGRES_DB=runpanel_test \
  -p 55432:5432 postgres:16-alpine

RUNPANEL_TEST_PG_URL=postgresql://runpanel:test@127.0.0.1:55432/runpanel_test npm test
```

Icons are bundled from a generated subset. After adding one, `npm run icons` —
though `predev` and `prebuild` run it for you, and the build fails on an icon
name that does not exist.

## Security

- Passwords hashed with bcrypt; sessions are per device and stored as a SHA-256
  of the cookie, so a database copy cannot be replayed
- Login rate limiting survives a restart
- Project env vars and service credentials encrypted at rest (AES-256-GCM)
- RunPanel's own configuration never reaches deployed projects
- Webhook signatures verified with HMAC-SHA256 and a constant-time compare
- Path traversal guarded on every file operation; ZIP uploads checked by magic
  bytes and capped

## Known gaps

- **Docker Compose is not supported.** A repository with only a
  `docker-compose.yml` cannot be deployed yet.
- **No registry authentication**, so private images cannot be pulled.
- **Light theme** is not shipped; the token layer is structured for it.
- Deploy presets exist (`services/deploy-presets`) but are not offered in the
  wizard yet.

## License

MIT
