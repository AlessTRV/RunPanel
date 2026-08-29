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
| `RUNPANEL_DATABASE_URL` | — | With `postgres` only |
| `RUNPANEL_TRUSTED_PROXY_HOPS` | `0` | How many reverse proxies sit in front |

> None of the `RUNPANEL_*` variables reach the projects you deploy. They are
> stripped from the child environment, because `RUNPANEL_SECRET` is the key your
> projects' own secrets are encrypted with.

The remaining variables, the choice between SQLite and Postgres, and what a
reverse proxy needs are in [Configuration](docs/en/configuration.md).

## Documentation

| | |
|---|---|
| [Configuration](docs/en/configuration.md) | Environment variables, SQLite or Postgres store, private registries, putting it on the internet |
| [Deploying a project](docs/en/deploy.md) | Sources, runtimes and presets, the deploy contract and `runpanel.json`, variables, what a deploy actually does |
| [Deploy automation](docs/en/automation.md) | Webhooks, polling for a panel nothing can reach, going back to a specific commit, one-time commands |
| [Databases and services](docs/en/databases.md) | Managed engines, console, folders shared with the host, linking one to a project |
| [Network access](docs/en/network.md) | Restricting a port to the addresses you name |
| [Backups and restore](docs/en/backups.md) | What is saved, how it is taken, where it goes, how it comes back |
| [Operations](docs/en/operations.md) | Starting at boot, updating the panel, Telegram notifications |
| [Architecture and development](docs/en/architecture.md) | Map of the code, the test suite, working on it |

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

For TLS and reverse proxies in front of the panel, see
[Putting it on the internet](docs/en/configuration.md#putting-it-on-the-internet).

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
