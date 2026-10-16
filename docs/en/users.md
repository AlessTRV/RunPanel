[← RunPanel](../../README.md) · [Italiano](../it/users.md) · **English**

---

# Users and permissions

The panel can have several accounts. The first is the **owner**: created on first run, it always has every permission and nobody can limit, disable or delete it. Every other account starts with no access and gets only what you give it.

With [several servers](multi-server.md) the accounts are the same everywhere and are managed from any panel; sessions and invitation links stay with the panel they were created on.

## Signing in

You sign in with email and password. The panel sends no email: the address is only your login name.

## Inviting someone

In **Accessi › Utenti › Invita utente** (access, users, invite user) type the email and choose how long the link lasts: 1 hour, 24 hours, 7 days or any duration up to 30 days. The panel shows the link **once** and you send it to the person yourself. The link works once: the person picks a password and is in.

From an account's page you generate a new link: an invitation if the account has no password yet, otherwise a link to choose a new one (that is how a forgotten password is solved). Every new link voids the unused ones, and using one signs that account out of every device.

## What an account can do

### Projects and services

A grant points at **everything**, a **folder**, a **project** or a **service**, with one of three levels:

| Level | Project | Service |
|---|---|---|
| Lettura (read) | status, logs, deploy history, variable names with masked values | status |
| Operatore (operate) | plus deploy, start, stop, restart | plus start, stop, restart |
| Gestione (manage) | plus settings, plain variables, files, mounts, one-time commands, deletion | plus credentials, databases inside, mounts, settings, deletion |

The **Terminale e console** switch, from Operatore up, opens a shell in containers and the database console. Each person has their own session.

The highest level among the grants that concern an item applies. A grant on a folder also covers what is added to it later, and a service linked to a project follows the project's access. There are no deny rules: to remove access you remove the row. Someone who cannot see a project gets "not found", as if it did not exist.

With several servers a grant can point at a project or service on any server: in the editor every item has the server's name next to it.

### Panel permissions

Per-account switches: Create projects and services, GitHub, Registries, Storage, Backup, Restore, Monitor, Autostart, Diagnostics, Notifications, Updates, Host access, Manage users, Activity log, Linked servers. Menu and buttons follow them, but the real check happens on the server, on every request and every stream.

To grant with care:

- **Host access.** Native runtimes (PM2), Compose, shared folders (services included), Docker capabilities, host networking, one-time commands and changing a project's code (files, uploads, repository) reach past the container, as far as the panel's database and its secret key. Without this permission, even an account with Manage on a project only works with plain Docker containers.
- **Backup and Restore.** An account other than the owner backs up and restores only the projects and services it manages, one by one. Backing up the panel itself, or including the secret key, stays with the owner.
- **Manage users.** It never allows touching the owner or oneself, granting a permission or level one does not hold, or editing, resetting or deleting an account with more access than one's own.
- **Linked servers.** Linking, diagnosing, changing the role of and revoking the cluster's servers, and regenerating the shared secret. It gives no access to the projects of other servers, which follow the usual permissions.

The **presets** fill the fields in one click and can then be adjusted:

| Preset | Permissions | Access |
|---|---|---|
| Visualizzatore (viewer) | none | Read on everything |
| Sviluppatore (developer) | Create projects and services, GitHub | Operate on everything |
| Operatore sistema (system operator) | Monitor, Storage, Backup, Autostart, Diagnostics | Operate on everything |
| Nessun accesso (no access) | none | none |

### Who has access

In a project's or service's settings, whoever manages users sees the accounts that reach it, with the level and where the access comes from, and can change them there.

## Revoking

Removing a grant, disabling or deleting an account, closing a session: it takes effect at once, and that user's open streams and shells close. Disabling an account signs it out of every device.

## Activity log

**Accessi › Registro attività** lists who did what: successful and failed sign-ins, invitations, permission changes, deploys, restarts, changes to variables and settings, terminals opened, backups, restores, updates, deletions. It filters by category and period. Each account sees only entries about resources it can see, and security entries only those who manage users. With several servers each server keeps its own log, and the page shows the selected server's.

The owner chooses which categories to record (Sicurezza, Deploy, Configurazione, Terminale, Backup, Sistema, Eliminazioni; security is always on) and for how many days to keep them, 1 to 3650 (90 by default). Entries hold names, never secret values, and a failed log write never blocks the action it describes.

## Upgrading from a password-only version

If the panel was set up when it had a single password, the first sign-in after the update is done with the email field empty; the panel then asks for it. Open sessions stay valid.
