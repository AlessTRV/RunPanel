[← RunPanel](../../README.en.md) · [Italiano](../it/deploy.md) · **English**

---

# Deploying a project

## Sources

- **GitHub** — connect a token on the GitHub page and pick the repository from a
  list, with branches loaded from the API. Or paste a public `https://` URL.
- **ZIP upload** — for code that is not on GitHub. The archive is unpacked
  in-process, refusing traversal entries and links, capped by both archive and
  decompressed size.

## Runtimes and presets

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
  commands**: the three fields are filled with its own, along with the runtime.
  Nothing is written until you save.

Precedence, lowest first: the detected preset, then the repository's
`runpanel.json`, then whatever you set in the panel.

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

Panel settings win where both specify a value.

Some fields are **panel-only** and are ignored when they come from a repository:
`docker.mounts`, `docker.capAdd`, `docker.network`, `docker.extraHosts`,
`docker.context`, `docker.dockerfile`, `docker.target`, `healthcheck.path`,
`healthcheck.port` and
`envFile.path`. They describe what the project may reach outside its own
container, and a `runpanel.json` must not be able to hand itself the host. When
one tries, the deploy log names the fields it dropped.

## Environment variables

A project's variables are managed on the **Variables** tab and are encrypted at
rest. They are passed to the process or the container and — when `envFile` is
enabled — also written to a file the app can read itself.

Variables prefixed `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_` or `REACT_APP_` are passed
to the **build** as well as the runtime. Frontends inline those into the client
bundle, so supplying them only at runtime ships the wrong value.

## What a deploy actually does

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
7. **Health check** — RunPanel probes the app until it answers.

**Re-Build** is the variant that cleans first: it removes `node_modules`,
`.next`, `venv` and the like per runtime, then rebuilds from the code already
checked out.
