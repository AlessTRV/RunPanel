# Users and permissions

[← Back to the README](../../README.md)

The panel can have several accounts. The first one is the **owner**: the initial setup creates it, it always holds every permission, and nobody can restrict, disable or delete it. Every other account starts with no access and gets only what you grant.

## Signing in

You sign in with email and password. The panel sends no email: the address is only your login name.

If you update a panel that was set up when it only had a password, sign in the first time after the update with the email field empty. The panel then asks for your email, and from then on you use email + password. Open sessions stay valid across the update.

## Inviting someone

In **Utenti → Invita utente**, enter the email and choose how long the link lasts: 1 hour, 24 hours, 7 days, or any duration up to 30 days. The panel shows the link **once**. You send it to the person however you like. It works a single time, then they choose a password and they are in.

From an account's page you can issue a new link: an invitation while the account has no password, a password reset once it has one. A new link voids every unused one. That is also how a forgotten password is handled, since the panel sends no reset emails.

## What an account can do

### Projects and services

A grant points at **everything**, a **folder**, a **project** or a **service**, with one of three levels:

| Level | What it allows |
|---|---|
| Read | status, logs, deploy history, variable names with masked values |
| Operate | plus deploy, start, stop, restart |
| Manage | plus settings, clear-text variables, files, mounts, one-time commands, deletion |

The **Terminal and console** switch, available from Operate up, opens a shell in containers. Each person gets their own session: nobody sees another person's output.

The highest grant that applies to an item is the one that counts. A folder grant also covers what is added to the folder later. A service linked to a project follows the project's grant. To take access away you remove the grant: there are no deny rules.

Someone who cannot see a project gets "not found", as if it did not exist.

### Panel permissions

These are per-account switches: Create projects and services, GitHub, Registries, Storage, Backup, Restore, Monitor, Autostart, Diagnostics, Notifications, Updates, Host access, Manage users, Activity log. The menu and the buttons follow them, but the real check happens on the server, on every request and every stream.

Three of them need care:

- **Host access.** Native runtimes (PM2), Compose, folder mounts, Docker capabilities, host networking, one-time commands, and changing a project's code (files, uploads, repository) can all reach past the container. That reaches the panel's database and its secret key. Without this permission, even an account with Manage on a project only works with plain Docker containers.
- **Backup and Restore.** An account other than the owner backs up and restores only the projects and services it manages, one by one. Backing up the panel itself, or including the secret key, stays with the owner.
- **Manage users.** It never lets anyone touch the owner or themselves. It cannot grant a permission or level its holder does not have, or edit or reset an account with more access than its holder.

The **presets** (Viewer, Developer, System operator) fill the fields in one click. You can then adjust them freely.

### Who has access

In a project's or service's settings, whoever manages users sees the accounts that reach it, with the level and where it comes from, and can change it there.

## Revoking

Removing a grant, disabling an account or closing a session takes effect immediately. Open streams close, and so do that user's shells. Disabling an account signs it out of every device.

## Activity log

**Registro attività** lists who did what: successful and failed sign-ins, invitations, permission changes, deploys, restarts, variable and setting changes, opened terminals, backups, restores, updates, deletions. You can filter by category and period. Each account sees only entries about resources it can see, and security entries are visible only to whoever manages users.

The owner chooses which categories are recorded and for how many days they are kept (90 by default). The Security category is always on. Entries carry names, never secret values, and a failed log write never blocks the action it describes.
