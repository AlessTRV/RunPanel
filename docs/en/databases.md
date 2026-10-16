[← RunPanel](../../README.md) · [Italiano](../it/databases.md) · **English**

---

# Databases and services

A *service* is a database managed by the panel: a labelled container, with its own volume and encrypted credentials. It lives on the server it was created on (with [several servers](multi-server.md), the one selected in the bar).

| Engine | Versions offered | Default port | Default variable |
|---|---|---|---|
| PostgreSQL | 18, 17, 16, 15, 14 | 5432 | `DATABASE_URL` |
| MySQL | 9, 8 | 3306 | `DATABASE_URL` |
| Redis | 8, 7, 6 | 6379 | `REDIS_URL` |
| MongoDB | 8.0, 7.0 | 27017 | `MONGODB_URL` |

The versions are the majors supported by the official image. The version is stored per service: when the list changes, an existing service is left alone.

At creation the user and database are `runpanel` and `runpanel_db`, with a random password; they can be changed. Redis only has a password. Seeing the credentials needs the Manage level on the service.

The port is published on every interface. To limit it to certain addresses, at creation or later, see [Network access](network.md).

## The console

Three modes: **Motore** (the engine's client, already signed in: `psql`, `mysql`, `redis-cli`, `mongosh`), **Shell** inside the container, and the container's live **Log**.

- Motore and Shell need the service running and the terminal permission on the service; every time the page opens there is a warning to accept, because from there data is deleted with no copy.
- Log shows the last 200 lines, works with the service stopped and is not saved.
- One session per person and per service, closed after 10 minutes idle.
- It is not a full terminal: you send one line at a time.

## Databases inside a service

In the **Database** tab a server can hold more than one: they are created and deleted, each with its own connection URL. The list merges what the engine reports with what the panel knows, and flags databases created outside the panel and those the engine no longer has.

- Names in lowercase, digits and underscore, at most 63 characters.
- System databases cannot be dropped; the main one goes only by deleting the service. A Postgres database with open connections is refused rather than force-closed.
- Redis has no named databases: the page explains how to use `/0`, `/1` and so on.

## Linking to a project

A service linked to a project gives it its connection URL in an environment variable. The link is made at creation or later, and can be removed or moved to another project. The variable reaches the app at the next deploy and on every restart.

A **switch** decides whether to inject it:

- **on**: the injected value wins over a variable of the same name set by hand, and the deploy log says so;
- **off**: the project uses its own variables.

The variable name can be changed. If two services of the same project would use the same name, at creation the second gets `<NAME>_DATABASE_URL`; when editing an existing link, the panel refuses and suggests a free name.

**The host depends on the project's runtime:**

- a **Docker** or **Compose** project gets the container name and the *internal* port (`runpanel-svc-<slug>-<name>:5432`), because RunPanel attaches the app to the `runpanel-net-<slug>` network at every deploy. For Compose it generates an override file next to the panel's data, leaving the repository's compose file alone; a service with `network_mode` cannot be attached and the log says so;
- a **native** project (under PM2) or a container on `network: host` gets `localhost` and the published port.

The service page shows the URL from each point of view and which one is injected, the project's **Variabili** tab shows the host the app will receive, and the deploy log prints the URL with the password masked.

A service can also be **standalone**, with no project: it injects nothing.

**Deleting the project does not delete its services.** They stay standalone, with container and data, in the project's folder. The delete dialog lists them: each can be deleted on its own, choosing whether to keep the volume, or a tick (off by default) deletes them all with the project, volumes included. **Rimuovi app** (remove app) removes only the app and leaves project and services.

## Folders shared with the host

A folder of the container can appear wherever you want on the host: configuration, logs, uploads, the data directory. You can add more than one, each can be switched on and, if needed, made read-only. It works for services and Docker projects alike, and needs the **Accesso all'host** permission.

A bind **replaces** the container's folder. That is why, the first time, the panel **seeds** it: it stops the service, copies the current content to the host keeping owners and permissions, and recreates the container. For the **engine's data directory** it also checks, before and after, that the databases are still there. If anything goes wrong it returns to the previous configuration by itself; if the panel goes down halfway, at the next start it rebuilds the last configuration that worked.

- If the host folder is not empty the panel stops and says so, with a box to adopt its content instead of copying over it.
- Refused: the data directory read-only, two binds on the same container path, the panel's data folder or one containing it, and a copy without at least 5% extra free space.
- Removing the data directory's bind needs a confirmation: the engine would go back to its previous volume, frozen at the moment the bind was added.

## Renaming a service

**Rinomina** changes the displayed name at once, everywhere: lists, notifications, backups. The **technical name** chosen at creation never changes, because it is part of the volume name (for example `runpanel-pg-<slug>-<name>`; `mysql`, `redis` and `mongo` for the other engines; without `<slug>` for a standalone service) and Docker cannot rename volumes.

The **container** takes the new name at the next deploy of the linked project. The database restarts for a few seconds on the same volumes, and the old name stays as an alias on the project network, so an app still running keeps reaching it. If the new name already belongs to another container the rename is skipped and the log explains why. A standalone service only changes its displayed name.
