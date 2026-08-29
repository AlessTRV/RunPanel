[← RunPanel](../../README.en.md) · [Italiano](../it/databases.md) · **English**

---

# Databases and services

A *service* is a database managed by the panel: a labelled container, with its
own named volume and encrypted credentials.

| Engine | Versions offered |
|---|---|
| PostgreSQL | 18, 17, 16, 15, 14 |
| MySQL | 9, 8 |
| Redis | 8, 7, 6 |
| MongoDB | 8.0, 7.0 |

These are the majors the official image supports today, minus the preview and
short-cadence channels. An existing service is untouched when the list changes:
the version is stored per row and recreations use that one.

## The console

The panel already knows the container name, the user and the password — the
three things you would go and look up before typing `docker exec` on the host.
The console uses them for you, in three modes: the **engine's own client**
already authenticated (`psql`, `mysql`, `redis-cli`, `mongosh`), a **shell**
inside the container, and the container's **log**, live. The log is read-only
and stored nowhere: it exists for as long as you are looking at it.

It is not a terminal emulator: `docker exec` with stdin on a pipe cannot allocate
a TTY, so it sends one line at a time. That is why the flags matter — without
`--table` MySQL answers in tab-separated columns, and without `--force` the first
syntax error would end the session.

There is a warning before the first session, and it has to be accepted: from
there you can delete data irreversibly, and the panel keeps no copy.

## Folders shared with the host

Any folder inside the container can appear wherever you want it on the host: the
configuration, the logs, the uploads, the data directory. Several of them, each
one switchable and optionally read-only. It works for services and for
Docker-runtime projects, through the same interface.

**The first time, the panel seeds**, and that is the part that matters. A bind
mount is not a synchronisation but a **substitution**: the host directory covers
that path inside the container, so without seeding you would see an empty folder,
and so would the service. The panel copies the current content out before
mounting; after that it is the same directory, sub-folders included, no
restart.

Seeding runs at two speeds. An ordinary folder is a copy. The engine's **data
directory** is the one case where getting it wrong is invisible: `cp` without
`-a` loses ownership and mode, and a Postgres that finds an empty directory
initialises from scratch, works perfectly, and has lost everything. That case
stops the service, copies with the permissions intact, recreates, **asks the
engine whether the databases are still there**, and puts everything back by
itself if they are not.

If the host folder is not empty it stops and says so, with a checkbox to adopt
what is already there rather than copy over it. And taking a bind *off* the data
directory is refused until you confirm: the engine would go back to the volume
it had before, frozen at the moment you added the bind, and come up on older
data without saying a word.

## Where a native project's files live

A project under PM2 has no container, so it has no binds: it has a directory.
From its settings it moves to another disk with everything in it —
`node_modules` and build output included, so it restarts without rebuilding.

A **symlink** stays at the old location: many places in the panel build
`data/repos/<slug>` from a slug alone, and the absolute paths already stored
point inside it. The link keeps every one of them resolving without touching any
of them. The original copy is not deleted: it stays until you say so.

## Linking one to a project

A service can be linked to a project, and then it supplies its connection URL in
an environment variable. The link has an **explicit switch**:

- **On**, the injected value wins over a variable you defined by hand, and the
  panel says so in the deploy log.
- **Off**, the project uses its own variables and the panel touches nothing.

The variable's name is editable (`DATABASE_URL` by default, derived from the
type). Two active links in one project cannot answer to the same key: the second
is refused, naming the first and proposing an alternative, instead of silently
overwriting it.

**The host depends on who is connecting**, and the panel shows the right line for
each: a container on the project network reaches the service by container name
and on its *internal* port; everything else — a PM2 process, a container on
bridge, your own `psql` — goes through the port published on the host.

A service can also be **standalone**, with no project: then it injects nothing
and is simply a database you manage from the panel.

## Databases inside a service

One database server holds several. The service page lists them by reading the
engine rather than a list of its own, and lets you create and drop them with the
connection URL ready for each.
