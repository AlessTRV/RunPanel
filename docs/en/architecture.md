[← RunPanel](../../README.md) · [Italiano](../it/architecture.md) · **English**

---

# Architecture and development

## Architecture

```
proxy.ts                refuses every /api request without a session or a valid cluster signature
instrumentation.ts      at boot: migrations, pending restores, then the timers
next.config.ts          security headers; distDir read from RUNPANEL_DIST_DIR (do not remove it)
app/
  (auth)/login          first run (owner or joining a cluster) and sign-in; invite/, setup-email/
  (panel)/              overview, projects, services, backups, monitor
    (system)/           System tabs: diagnostics, autostart, updates, storage, servers
    (access)/           Access tabs: users, audit
    (settings)/         Settings tabs: account, settings (Pannello), github
  api/                  REST handlers; /projects/:id/stream is the SSE channel
    cluster/            linking, ping, directory, members, secret
    nodes/[id]/[...]    signed forwarding of a call to another server
components/             interface; components/ui/ is the kit (HeroUI 3, Tailwind 4)
lib/
  env.ts, config.ts     validated environment, data paths, secret key
  db/                   Kysely schema, migrations, both dialects
  nav.ts                menu, section tabs, command palette
  authz.ts              who may do what: levels, grants, permissions, no imports
  auth-guard.ts         the require* every handler starts with (401, 403, 404)
  principal.ts          loads accounts and references for authz.ts
  users.ts              accounts, invitations, grants; emits authzEvents
  stream-guard.ts       rechecks access for open SSE streams and shells
  request-origin.ts     refuses writes from another origin
  host-guard.ts         what needs the "Host access" permission
  audit.ts              activity log (pure rules in audit-filter.ts)
  cluster-sign.ts       HMAC signing of requests between servers, no imports
  cluster-directory.ts  merge of the replicated directory, no imports
  cluster-auth.ts       signature verification, each accepted once
  node-api.ts           /api/x → /api/nodes/<id>/x for the selected server
  server-url.ts         the server in the page's address (?server=)
  cluster-merge.ts      merging the servers' answers and per-server warnings, no imports
  deploy-contract.ts    the contract, its parser and preflight checks
  deploy-phases.ts      the points a one-time command can pin to
  ip-access.ts          CIDR matching, and the host's own networks
  service-versions.ts   which engine versions are offered
  hooks/                SSE streams, polling (useResource), selected server (useNode), user (useMe)
services/
  deploy-pipeline.ts    the deploy orchestrator
  deploy-queue.ts       one deploy at a time per project, plus one waiting
  deploy-poll.ts        polling-based auto-deploy
  one-time-commands.ts  the one-time queue: claim, run, outcome, history
  access.ts, access-gate.ts  the TCP gates in front of restricted ports
  cluster/              cluster state, signed client, fan-out to every server, directory, join, sync
  backup/               policies, dumps, archives, destinations, restore
  autostart/            detection, unit generation, reconcile
  panel-update/         check, staged build, swap, restart exit
  notify/               events, message text, Telegram bot, host checks
  docker/               cli, registries, labels, images, volumes, stats, cleanup
  builders/             node, docker, static, compose, custom
  process-drivers/      pm2, docker, compose
  service-templates/    postgresql, mysql, redis, mongodb
scripts/                memory-capped build, lint, icon generation
tests/                  runner, harness and suites
data/                   runtime state (gitignored)
```

Every `/api` route goes through `proxy.ts`, which refuses requests without a session. The exceptions are the public routes (sign-in, sign-out, sign-in state, invitations, the GitHub webhook, joining the cluster with a token), signed calls between servers of the cluster, and the two routes with large bodies (ZIP upload and forwarding to another server), which make the same checks themselves. Every handler still starts with a guard from `lib/auth-guard.ts`, and `authz-coverage-unit` fails if one does not. The permission model is in [Users and permissions](users.md), the cluster in [More than one server](multi-server.md).

## Development

```bash
npm run dev            # development server
npm run build          # production build, with a memory ceiling
npm start              # start the last build
npm run typecheck
npm run lint
npm test               # full suite
npm test -- <suite…>   # only the suites named
npm run test:quick     # skip the suites that need Docker
npm run icons          # regenerate the icons after adding one
```

The build uses at most 40% of RAM (between 1 and 4 GB), because the panel rebuilds itself on the machine that runs the projects; a `NODE_OPTIONS` already set wins.

There are two kinds of suite:

- **standalone** (every `*-unit` and a few more): they load the module under test directly, with no server or daemon, and cover the pure rules: CIDR matching, the deploy contract, signing, the directory merge, migrations.
- **with a server**: each starts `next start` on a temporary data directory. They run the **last build**, so after a change run `npm run build` before them.

The runner skips what the machine cannot do instead of failing: suites that need Docker (`--no-docker` excludes them), and `native-runtime` and `one-time-deploy`, which need PM2 (`npm i -g pm2`; `--no-pm2` excludes them). They show as `SKIP` in the summary.

Suites that declare the Postgres driver run on Postgres too only when `RUNPANEL_TEST_PG_URL` is set:

```bash
docker run -d --name rp-test-pg -e POSTGRES_PASSWORD=test \
  -e POSTGRES_USER=runpanel -e POSTGRES_DB=runpanel_test \
  -p 55432:5432 postgres:18-alpine

RUNPANEL_TEST_PG_URL=postgresql://runpanel:test@127.0.0.1:55432/runpanel_test npm test
```

Icons are a generated subset: `predev` and `prebuild` regenerate it, and the build fails on an icon name that does not exist.
