[← RunPanel](../../README.md) · [Italiano](../it/configuration.md) · **English**

---

# Configuration

Everything lives in `.env` in the panel's folder; `.env.example` is the commented version. The variables in the table are checked at boot: a wrong value stops the panel with a message, instead of failing later on the first request that uses it.

| Variable | Default | What it does |
|---|---|---|
| `RUNPANEL_SECRET` | generated in `<data>/.secret` (mode 0600) | Encryption key, hex, at least 64 characters. See below |
| `RUNPANEL_DATA_DIR` | `./data` | Store, repositories, logs, archives |
| `PORT` | `3000` | The panel's port |
| `RUNPANEL_DB_DRIVER` | `sqlite` | `sqlite` or `postgres` |
| `RUNPANEL_DB_FILE` | `<data>/runpanel.db` | `sqlite` only; a relative path starts from the panel's folder |
| `RUNPANEL_DATABASE_URL` | — | `postgres` only (`DATABASE_URL` is accepted too) |
| `RUNPANEL_PG_HOST` `_PORT` `_USER` `_PASSWORD` `_DATABASE` | port `5432` | Alternative to the URL; host, user and database required |
| `RUNPANEL_PG_SSL` | `disable` | `disable`, `require`, `no-verify` |
| `RUNPANEL_PG_POOL_MAX` | `10` | Maximum pool connections, 1 to 100 |
| `RUNPANEL_TRUSTED_PROXY_HOPS` | `0` | How many reverse proxies sit in front, 0 to 10. See [Putting it on the internet](#putting-it-on-the-internet) |
| `RUNPANEL_DISABLE_SCHEDULERS` | off | `1`, `true` or `yes`: turns timers and access gates off. See below |
| `RUNPANEL_SETUP_TOKEN` | issued at each boot | Pins the first-run token, which also guards [linking the server to a cluster](multi-server.md). Not validated |
| `RUNPANEL_DEV_ORIGINS` | — | `next dev` only: extra hosts, comma-separated, with `*` and `**` wildcards (no CIDR). Not validated |

**The secret key.** It encrypts project variables, service credentials, registries, backup destinations, the GitHub token and the Telegram bot. If it changes or is lost, all of these become unreadable: keep it with your backups. With [several servers](multi-server.md) each install has its own; shared values (GitHub token, Telegram bot) are encrypted again by each server.

**Background timers.** `RUNPANEL_DISABLE_SCHEDULERS` is for a test instance next to the real one. It turns off Docker cleanup, scheduled backups and restarts, auto-deploy, the update check, cluster sync, status checks with their notifications, and bringing projects and services back after the machine reboots. It also turns off the access gates: restricted ports stay closed.

**What projects see.** No `RUNPANEL_*` variable, nor `DATABASE_URL`, reaches your projects' build commands, processes or containers: the secret key, the store's credentials and the setup token stay with the panel.

## The store: SQLite or Postgres

```bash
RUNPANEL_DB_DRIVER=postgres
RUNPANEL_DATABASE_URL=postgresql://user:pass@host:5432/runpanel
```

SQLite is the default and the case the panel is designed for. Postgres is for a store that has to live off the machine or be backed up by your own infrastructure. Schema and queries are the same on both drivers. Migrations are applied at boot, before the first request.

## Private registries

Added under **Impostazioni › Pannello › Registry privati**. Credentials are encrypted in the store and written at every boot to a Docker configuration of the panel's own (`<data>/docker-config`), never to `~/.docker`: your personal credentials do not mix with the panel's.

## Putting it on the internet

Terminate TLS in front of the panel and tell it how many proxies it sits behind:

```bash
RUNPANEL_TRUSTED_PROXY_HOPS=1
```

The panel reads the client's address from `X-Forwarded-For` counting proxies from the right, because the first entry is chosen by the client. With `0` it trusts no address, and sign-in attempts are limited only overall (20 per 15 minutes) and per account (10). With a proxy configured a per-address limit is added (5), and the panel can suggest your address in the [network rules](network.md).

In production builds the session cookie is `Secure`, so it only works over HTTPS or on localhost, and the panel sends HSTS. The address the panel presents itself with (links in notifications, webhooks) is set under **Impostazioni › Pannello › Indirizzo pubblico**: see [Automation](automation.md).
