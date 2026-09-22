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

## Project volumes

With **Docker volumes** among the things to save, a project brings every one of
its volumes into the archive, one `projects/<slug>/volumes/<volume>.tar.gz` each.
That holds for a single project and for "all projects". There are two kinds:

- the ones RunPanel creates and labels itself (`runpanel.project=<slug>`), such
  as the volume of a database linked to the project;
- the ones created by the project's **Compose stack**. Compose accepts no labels
  on `up`, so the handle is the Compose project name, `runpanel-<slug>`: a volume
  is included when `com.docker.compose.project` is exactly that. `runpanel-shop`
  never picks up the volumes of `runpanel-shop2`, and an unlabelled volume is
  never included.

The backup log lists the volumes found for each project. If Docker does not
answer, the project shows up as a skipped entry with the reason: an empty list no
longer passes silently for "no data".

### Consistency of the copy

Copying a volume while the app writes to it can produce a database whose files
were taken at different moments — one that restores without an error and is
broken. So each project's **Settings → Volume backup** chooses what happens
during the copy:

| Mode | What it does |
|---|---|
| **Pause the writers** (default) | `docker pause` on the project's containers that mount that volume read-write, only for as long as it is read. The copy is *crash-consistent*: the state a power cut would leave, which SQLite (WAL included) and Postgres recover from on their own. |
| **Live copy** | No pause. The copy may be inconsistent, and the log and the manifest say so every time. |

The downtime is kept as short as possible: while paused, the volume is written to
disk **uncompressed**, at disk speed; compression happens afterwards, with the
containers running again. Only when the free space (beyond the 2 GB reserve)
cannot hold that copy plus its compressed version is it compressed during the
pause, which then lasts longer, and the log says so. A pause longer than 10
minutes is cut short, the containers resumed, and the volume marked as not saved.
Containers that mount the volume read-only are left running; another project's
container writing into the same volume is never touched, and the copy is marked
as not guaranteed.

The ids of paused containers are written to disk
(`data/backups/paused-containers.json`) for as long as the pause lasts: if the
panel dies mid-copy, the next boot — or the next backup — resumes them. A paused
container does not count as crashed for the status check, so a backup raises no
crash notifications.

**Pre-backup command.** Compose projects can add a command to run, once per
backup, in one service of the stack before its volumes are copied (`sh -c`, with
a timeout): an SQLite `.backup` or a `pg_dump` into the volume, for instance. If
it fails and the copy is paused, the backup goes ahead; if the copy is live, the
volume is not saved, since with neither the command nor a pause nothing would
make it consistent.

The log says what happened, volume by volume:

```
→ memebot: volume runpanel-memebot_memebot-data
  esclusi: trades (492 MB)
  in pausa: memebot-record, memebot-label, memebot-telegram
  ripresi dopo 8,4 s di pausa
```

and the manifest records it in the entry's `meta`: `consistency` (`result`
`paused`, `idle` or `live`, who was paused, for how many milliseconds, who was
not and why, `method` `snapshot` or `stream`), `preBackup`, `excludes` and
`excluded`.

### Exclusions

Also from **Volume backup**, each volume can leave paths out, one per line,
relative to the volume's root: `trades` excludes the folder and everything in it
(and only that one: `reports/trades` stays). No `..`, no leading `/`, no
wildcards — so the path as typed and the path `tar` excludes are the same thing.
The log reports each exclusion with its size, or "non presente nel volume" when
it matches nothing, and the manifest lists them.

### Restoring a volume

The restore stops the project, then checks that no container still has the
volume mounted: whatever of the project is still up (a Compose stop that failed,
a linked service) is stopped and started again at the end; a container that is
not the project's blocks the restore, and the volume is left untouched. The paths
the backup excluded stay **as they are**: the archive does not hold them, so it
neither overwrites nor deletes them. A Compose volume that no longer exists is
recreated by deploying the project; then run the restore again.

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
