[← RunPanel](../../README.en.md) · [Italiano](../it/architecture.md) · **English**

---

# Architecture and development

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
