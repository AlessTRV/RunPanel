[← RunPanel](../../README.en.md) · [Italiano](../it/configuration.md) · **English**

---

# Configuration

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

## The store: SQLite or Postgres

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

## Private registries

Docker registry credentials are entered from the panel, encrypted at rest and
written back into Docker's configuration at boot — the data directory can outlive
a container rebuild, and a missing auth file shows up as a `pull access denied`
that tells you nothing useful.

## Putting it on the internet

Terminate TLS in front of the panel and tell it how many proxies it is behind:

```bash
RUNPANEL_TRUSTED_PROXY_HOPS=1
```

Without it the panel cannot believe any client address — `X-Forwarded-For` is
appended to by each hop, so the first entry is the client's own — and falls back
to a single account-wide login limit. The session cookie is marked `Secure` in
production builds, which browsers only accept over HTTPS or on localhost.
