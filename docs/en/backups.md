[← RunPanel](../../README.md) · [Italiano](../it/backups.md) · **English**

---

# Backups and restore

A *policy* says what to save, where, how often and how many archives to keep. Policies, destinations, archives and restores belong to the server they are on: with [several servers](multi-server.md) each has its own, and an archive can only be decrypted with the key of the server that took it.

Accounts other than the owner back up and restore only the projects and services they manage, one at a time (see [Users and permissions](users.md)).

## What can be saved

| Target | What it covers |
|---|---|
| One service | the whole dump (`pg_dumpall`, roles included, for Postgres) or the databases you pick |
| All services | including the ones you create later |
| One project | your choice of: configuration, Docker volumes, repository |
| All projects | same rule, future ones included |
| The panel | RunPanel's store, with or without the encryption key |

Every dump runs **inside the container it belongs to**, so client and server are the same version. The panel's SQLite store is captured with `VACUUM INTO` and checked with `PRAGMA integrity_check`; the Postgres store with a custom-format `pg_dump`, in a container of the same major.

A project uploaded as a ZIP always includes its repository. The repository copy skips `node_modules`, `.next`, `dist`, `build`, `vendor`, `.venv` and the like, and the `.env` the panel writes.

## Project volumes

With **Docker volumes** among the things to save, a project brings every volume of its own into the archive (`projects/<slug>/volumes/<volume>.tar.gz`):

- those RunPanel creates with the `runpanel.project=<slug>` label, for instance the volume of a linked database;
- those of the project's **Compose stack**, recognised by the exact Compose project name `runpanel-<slug>` (`runpanel-shop` never takes `runpanel-shop2`'s volumes).

An `external: true` volume does not belong to the stack and is not backed up: save it separately. The log lists the volumes found for each project; if Docker does not answer, the project shows as skipped with the reason.

### Consistency of the copy

Copying a volume while the app writes to it can produce a database that restores without errors and is broken. In the project's **Impostazioni** tab, **Backup dei volumi** section (volume backup), you choose what happens during the copy:

| Mode | What it does |
|---|---|
| **Metti in pausa chi scrive** (pause the writers, default) | `docker pause` on just the project's containers that mount the volume read-write, for just the time of the read. The copy is what a power cut would leave, which SQLite (WAL included) and Postgres recover from by themselves. |
| **Copia a caldo** (live copy) | No pause. The copy may be inconsistent, and log and manifest say so. |

To keep the pause short, the volume is written to disk uncompressed and compressed afterwards, with the containers resumed. If free space (beyond a 2 GB reserve) is not enough, it is compressed during the pause at the fastest level; if even that will not fit, the volume is refused before anything is paused. A pause over 10 minutes is broken off, the containers resumed and the volume marked as not saved. Read-only containers are not paused; a container of another project writing to the same volume is never touched, and the copy is marked as not guaranteed.

If the panel stops during a pause, the containers are resumed at the next start or the next backup. A paused container triggers no crash notifications.

**Comando prima del backup** (pre-backup command). For Compose projects, a command run once per backup in a service of the stack before the volumes are copied (`sh -c`, timeout 5 to 3600 seconds): for instance a SQLite `.backup` or a `pg_dump` into the volume. If it fails with the pause on, the backup goes on; if it fails with a live copy and something is writing, the volume is not saved.

### Exclusions

Still in **Backup dei volumi**, each volume can exclude paths relative to its root, one per line: `trades` excludes that folder and its content, not `reports/trades`. No `..`, no leading `/`, no wildcards. The log (in Italian) reports each exclusion with its size, or "non presente nel volume" (not in the volume):

```
→ memebot: volume runpanel-memebot_memebot-data
  esclusi: trades (492 MB)
  in pausa: memebot-record, memebot-label, memebot-telegram
  ripresi dopo 8,4 s di pausa
```

## Where they go

- **Disco locale** (local disk): always `data/backups/archives/<year>/<month>`, files 0600. Created at first start and the default destination; the path cannot be changed.
- **S3-compatible**: AWS S3, Cloudflare R2, MinIO, Backblaze B2. Endpoint, region, bucket, keys, optional prefix and path-style addressing; configuration encrypted. `https://` anywhere, `http://` only to a private address. **Verifica** (check) writes and deletes a test object. The object is named `<prefix>/<file>` and uploaded in one request: on AWS the 5 GB per-object limit applies.

Every archive is first built in `data/backups/staging`, S3 included: local free space is needed, and the backup stops if it falls under 2 GB.

The archive is a zip with `manifest.json`, `LEGGIMI.txt` and a `checksums.txt` in `sha256sum -c` format (for dumps and volumes; repository files are not listed). Project variables and service credentials are encrypted with this server's key; including the key itself is a separate, explicit choice.

## Schedule and retention

- **Schedule**: five-field cron or `@daily` and friends, in the timezone you pick (the panel's by default). Empty means **Solo su richiesta** (on demand only). Seconds, `L`, `W`, `#` and `@reboot` are not supported.
- **One backup at a time**, and none during a restore. A scheduled run that finds the system busy is skipped, not queued. A run missed while the panel was down is caught up only within twice the interval, or 24 hours if longer.
- **Retention**: count (1–1000), age (1–3650 days) and total size (at least 1 MB), together. It is applied after a successful run, and the newest valid archive is never removed.

## Restore

An archive on S3 is first downloaded into the restore's working folder (free space is needed, plus the 2 GB reserve) and deleted at the end. Restore shows the archive's content: pick the items (only those saved successfully) and, for each, where to restore it: the same service or project, or another of the same kind. To confirm, type the name of the first target.

Before overwriting, the panel takes a **safety backup** of the targets on the local disk (labelled "Sicurezza pre-ripristino", never removed by retention, deleted by hand). If it fails the restore stops, unless you ticked **Procedi anche senza backup di sicurezza** (go on without a safety backup).

- **Volume**: the project stops; its containers still running are stopped and restarted at the end, while a container of another project using the volume blocks the restore. Excluded paths are left as they are. A Compose volume that no longer exists is recreated by a deploy, then the restore is repeated.
- **Repository**: files are overwritten, extra files are not deleted.
- **A project's configuration**: the project must still exist.
- **Panel store (SQLite)**: not restored live. The database is set aside and takes over at the next restart, with the previous one kept next to it. The encryption key is not put back: if needed, copy it by hand.
- **Panel store (Postgres)**: refused by the panel; the `pg_restore` command to run with the panel stopped is in `manifest.json`.

Restore does not compare engine versions: a dump from one major restored onto another is accepted and fails halfway, with the safety backup already taken.
