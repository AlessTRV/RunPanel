[← RunPanel](../../README.en.md) · [Italiano](../it/backups.md) · **English**

---

# Backups and restore

A *policy* says what to save, how often, and how much of it to keep.

## What can be saved

| Target | What it covers |
|---|---|
| One service | the database dump, whole or a single database |
| All services | a selector: it covers the one you create tomorrow |
| One project | configuration, volumes, repository — your choice |
| All projects | same rule |
| The panel | RunPanel's own store, with or without the encryption key |

Targets are selectors rather than fixed lists, so "every database" keeps meaning
the ones that exist when the backup runs.

## How they are taken

Every dump runs **inside the container it belongs to**, so the client and the
server are always the same version. RunPanel's own SQLite store is captured with
`VACUUM INTO` and then verified with `PRAGMA integrity_check`, never copied.

## Where they go

- **Local disk** — `data/backups/archives/<year>/<month>`, mode 0600.
- **S3-compatible** — AWS S3, Cloudflare R2, MinIO, Backblaze B2. SigV4 is signed
  in-house, no SDK. The endpoint accepts `https://` anywhere and `http://` only
  towards a private address: an archive holds every environment variable in the
  panel.

The archive is a plain zip with a `manifest.json` and a `checksums.txt` in
`sha256sum -c` format, so it can be verified and unpacked without RunPanel. Env
vars and service credentials inside it are re-encrypted with this panel's key;
including the key itself is a separate, explicit choice.

## Schedules, retention, restore

| | |
|---|---|
| Schedules | five-field cron plus the `@daily` family, in the timezone you pick |
| Retention | count, age and total size, together — the newest good archive is never collected |
| Restore | guided, with an automatic pre-restore backup that aborts the restore if it fails |

The restore shows what the archive holds and lets you choose entry by entry. The
panel's own store is the one thing not restored live: the restored database is
staged and put into service at the next boot, with the previous one kept beside
it.
