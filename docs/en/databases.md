[← RunPanel](../../README.md) · [Italiano](../it/databases.md) · **English**

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

**The host depends on the project's runtime**, and the panel decides it alone:

- a **Docker** or **Compose** project receives the container name and the
  *internal* port (`runpanel-svc-<slug>-<name>:5432`), because RunPanel attaches
  the app to the `runpanel-net-<slug>` network on every deploy. A Docker
  container is put there at start; a Compose stack gets a generated override
  file next to the panel's data — the repository's compose file is never
  rewritten — adding the network to every service of the stack. A service on
  `network_mode` cannot be attached, and the deploy log says so;
- a **native** project (Node.js, Python, Custom under PM2) receives `localhost`
  and the published port, because it runs on the host. So does a container on
  `network: host`.

Inside a container `localhost` is the container itself, and
`host.docker.internal` goes through the host's firewall, which may drop it: that
is why container projects use the network rather than the published port. The
service page shows the line for each viewpoint and says which one is injected;
the project's Variables tab prints, under the variable, the host the app will
receive; and the deploy log prints the injected URL with the password masked.

A service can also be **standalone**, with no project: then it injects nothing
and is simply a database you manage from the panel.

**Deleting the project does not delete its services.** They stay on as
standalone services, container and data included, in the folder the project was
in. The deletion panel lists them: each can be deleted on its own, choosing
whether to keep its volume, and one checkbox — off by default — takes them all
down with the project, volumes included. The app alone goes with "Remove app",
which leaves project and services where they are.

## Renaming a service

The **Rename** button on the service page changes the name the panel shows, at
once and everywhere: lists, notifications, backups. Like a project's slug, the
**technical name** chosen at creation never changes: it is part of the data
volume's name (`runpanel-postgres-<slug>-<name>`), and Docker cannot rename a
volume. A different technical name would restart the database on a new, empty
volume.

The **container** takes the new name at the **next deploy of the project** the
service is linked to, deploy or rebuild. That is when the app restarts anyway,
and when it is handed the new host in its connection URL. The database restarts
for a few seconds, on the volumes it had; the container's old name stays as an
alias on the project network, so the app still running from the previous deploy,
or left running by a deploy that fails further on, keeps reaching it. The deploy
log says what was renamed and where the data is. If the new name already belongs
to another container, the rename is skipped and the log explains why. Until the
deploy comes, the service page shows the name the container will take.

A standalone service only changes the name shown: no deploy restarts it. The same
principle holds for every recreate (an access change, shared folders): the
container comes back on the volume it really has, asked of Docker, even after
being moved to another project.

## Databases inside a service

One database server holds several. The service page lists them by reading the
engine rather than a list of its own, and lets you create and drop them with the
connection URL ready for each.
