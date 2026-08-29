[← RunPanel](../../README.en.md) · [Italiano](../it/operations.md) · **English**

---

# Operations

## Starting at boot

The Autostart page reports what this host already does and generates what it
does not: a systemd unit with absolute paths, ordered after `docker.service` and
requiring it, or a supervised `@reboot` script when systemd is not available. If
RunPanel runs as root it installs it; otherwise it renders a single block to
paste. It never runs `systemctl start` — that would put a second panel on the
port next to the running one.

It also checks the things that make autostart useless when they are missing:
whether Docker itself is enabled at boot, and whether `pm2 save` has ever been
run — without it, PM2 brings back nothing after a reboot even when the panel
comes back.

Inside the panel, each project and service has a switch, an order, a delay, and
whether to wait for it to answer before starting the next one. The reconciler
that applies this at boot is a **repair** pass: it waits for Docker's own
restarts to settle and starts only what is still down, and it never triggers a
build.

The generated unit carries `KillMode=process`: without it a `systemctl stop
runpanel` would take down PM2 too, along with every native-runtime project it
supervises. Docker containers are never involved. If the unit was installed
before this, the Autostart page says so and reinstalling it is enough.

The status shown in the lists re-checks itself, every half minute and at the end
of the boot reconciliation: a project can therefore go to **Stopped** with nobody
having stopped it just then, and it means it had not been up for a while. The
check starts nothing and stops nothing, and before calling something stopped that
claimed to be running it waits for two readings that agree, so a `pm2` that fails
to answer for an instant does not paint the whole panel red.

## Updating the panel

RunPanel is installed by cloning it, so the directory it runs from is a git
working tree — which is all it needs to know whether a newer version exists. The
version shown reads `v0.1.0+125`, where the number after the `+` is the mainline
commit count (`git rev-list --count --first-parent`); on a shallow checkout the
count means nothing and the panel shows the SHA instead. Every six hours, and the
interval is a setting on the page, it runs a `git fetch` against its own remote
and compares: outbound only, and no token at all for a public repository. When
the branch has moved a strip appears at the top of every page with the number of
commits and an **Aggiorna** button; the Updates page lists the commits.

The check **never applies anything by itself**.

Once pressed, the panel copies its store, fetches, aligns the checkout, installs
dependencies, builds and restarts. Two things to know:

- **The build does not go into `.next`.** The new version is built in
  `.next-update` and takes the place of the live one with two renames, only after
  it has been verified; the previous build stays in `.next-old` until the next
  boot.
- **The restart is an exit.** The panel exits with code 75 and whatever already
  supervises it brings it back: systemd with `Restart=always`, or the loop in the
  `@reboot` script. No `systemctl`, no privileges.

If anything fails before the swap, the checkout is reset to the commit it started
from and dependencies are reinstalled: `.next` was never touched, so the panel
carries on running the previous version without noticing.

An update is refused when the panel is not a git checkout, when HEAD is detached,
when it runs inside a container — there the route is to rebuild the image — and on
Windows, where a build directory cannot be renamed while the process holds it
open. With no supervisor at all the update is still fetched and built, but stops
**before** the swap and hands over the two commands to run.

Uncommitted local changes are discarded (`git reset --hard` followed by
`git clean -fd`). The clean runs without `-x`, so nothing ignored is touched —
`data/`, `node_modules/`, `.next` — and `.env*` files are excluded explicitly.
Whatever is about to be removed is listed in the log before it is removed.

Before starting, the panel takes a copy of its own store with `VACUUM INTO` and
writes the path into the log. An update is refused while a deploy or a backup is
running.

Should the panel not come back, the commands to put the previous version back are
in two places that need no working panel: printed to the journal immediately
before the exit, and in `<dataDir>/panel-update.json`.

## Telegram notifications

The panel can tell you when something happens that you would want to know about
without having the panel open. It is set up under **Impostazioni → Notifiche
Telegram**: create a bot with `@BotFather`, paste the token, send your bot any
message, and press **Rileva** — the panel asks Telegram who has written to it and
offers the list, so the chat id is not something you have to go and find
elsewhere.

Telegram is the channel for the same reason [polling](automation.md) exists:
**the panel only ever dials out**, and does not need to be reachable from the
internet. The price is that the bot cannot be talked to: there are no commands,
it only sends.

The token is encrypted at rest like the GitHub one and never comes back out of
this page: the screen only learns whether one exists.

### What gets announced

| Event | When |
|---|---|
| **Project or service stopped** | The process is gone and it was not the panel that stopped it |
| **Docker unreachable** | The daemon stopped answering, and again when it comes back |
| **Deploy finished** | Always for automatic deploys; for manual ones only on failure |
| **Backup finished** | Success, partial or failure, with artefacts, size and duration |
| **Update available** | The periodic check found new commits on RunPanel |
| **The panel restarted** | After a reboot or an update |
| **Disk space** | Below 10% free on the data directory, and when it recovers |

Each one has its own switch: a noisy one can be silenced without losing the rest.

Crashes are confirmed across two readings, so a `pm2` that fails to answer for a
moment sends nothing.

A manual deploy that succeeded is not announced — you are already watching it,
with the log streaming — but a failed one is.

### Why it does not bury you

Everything is **edge-triggered**: what gets announced is the moment a threshold
is crossed, not the state. The disk threshold carries two points of hysteresis.
On top of that there is a fifteen-minute silence per event and per subject — per
subject rather than globally, so one project flapping does not hide another
falling over at the same moment. A panel update is announced when the target
commit changes, not while one exists.

### When a notification cannot be sent

Nothing happens: a deploy does not fail because Telegram did not answer. A failed
send lands in the panel's log with the reason, translated where Telegram is
particularly cryptic — `chat not found` usually means you have not written to the
bot yet, and until you do, a bot cannot write to you.
