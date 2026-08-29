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

The generated unit carries `KillMode=process`, which is not a detail: PM2 is
spawned by the panel, so it lands in that unit's cgroup, and with systemd's
default a `systemctl stop runpanel` kills it too, along with every native-runtime
project it supervises. Docker containers are never involved — they belong to
Docker's cgroup. If the unit was installed before this, the Autostart page says
so and reinstalling it is enough.

The status shown in the lists re-checks itself, every half minute and at the end
of the boot reconciliation. It used to be the panel's memory of the last command
it issued rather than the state of the machine: anything that stopped without
going through here — a reboot, a process killed for memory, a `docker stop` from
a shell, the panel itself going down and taking its children with it — left the
green dot on for good. Now the panel looks, and a project can go to **Stopped**
by itself with nobody having stopped it just then: it means it had not been up
for a while. The check starts nothing and stops nothing, and before calling
something stopped that claimed to be running it waits for two readings that
agree, so a `pm2` that fails to answer for an instant does not paint the whole
panel red.

## Updating the panel

RunPanel is installed by cloning it, so the directory it runs from is a git
working tree — which is all it needs to know whether a newer version exists, and
also *which* version this is. The version shown reads `v0.1.0+125`: the number
after the `+` is the mainline commit count
(`git rev-list --count --first-parent`), which climbs on its own and cannot be
forgotten, while `package.json`'s `0.1.0` has never moved. On a shallow checkout
the count means nothing and the panel shows the SHA instead.
Every six hours, and the interval is a setting on the page, it runs a `git fetch`
against its own remote and compares: outbound only, exactly as for a project, and
no token at all for a public repository. When the branch has moved a strip appears at
the top of every page with the number of commits and an **Aggiorna** button; the
Updates page lists the commits, so pressing that button is a decision rather than
an act of faith.

The check **never applies anything by itself**. That is the deliberate difference
from a project's auto-deploy: somebody who turns auto-deploy on has asked for
their own code to be rebuilt, and nobody asks for the thing they are currently
looking at to restart underneath them.

Once pressed, the panel copies its store, fetches, aligns the checkout, installs
dependencies, builds and restarts. Two details are worth knowing:

- **The build does not go into `.next`.** `next build` empties and rewrites its
  output directory, and the running panel reads from there on every request:
  building in place would break the page showing the progress, and a build that
  failed halfway would leave a panel that cannot start. The new version is built
  in `.next-update` and takes the place of the live one with two renames, only
  after it has been verified. The previous build stays in `.next-old` until the
  next boot.
- **The restart is an exit.** The panel exits with code 75 and whatever already
  supervises it brings it back: systemd with `Restart=always`, or the loop in the
  `@reboot` script. No `systemctl`, no privileges. `KillMode=process` guarantees
  PM2, native projects and containers are left alone.

If anything fails before the swap, the checkout is reset to the commit it started
from and dependencies are reinstalled: `.next` was never touched, so the panel
carries on running the previous version without noticing.

An update is refused when the panel is not a git checkout, when HEAD is detached,
when it runs inside a container — there the change would live in the writable
layer and vanish the first time the container is recreated, so the route is to
rebuild the image — and on Windows, where a build directory cannot be renamed
while the process holds it open. With no supervisor at all the update is still
fetched and built, but stops **before** the swap and hands over the two commands
to run: a build swapped under a process that keeps running would not work.

Uncommitted local changes are discarded (`git reset --hard` followed by
`git clean -fd`), and that is necessary: `lib/icons.generated.ts` is tracked and
`prebuild` regenerates it, so an installation's tree is dirty after every build.
The clean runs without `-x`, so nothing ignored is touched — `data/`,
`node_modules/`, `.next` — and `.env*` files are excluded explicitly. Whatever is
about to be removed is listed in the log before it is removed.

Before starting, the panel takes a copy of its own store with `VACUUM INTO` and
writes the path into the log: migrations run by themselves at boot, and a
migration that fails leaves a panel that is down, which means there is no UI left
to fix it from. An update is refused while a deploy or a backup is running,
because the restart would cut either in half.

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

Telegram is the channel for the same reason the periodic repository check exists:
**the panel only ever dials out**. It does not need to be reachable from the
internet, which is true of a great many self-hosted installations — behind NAT,
on a Tailscale network, on a laptop. The price is that the bot cannot be talked
to: there are no commands, it only sends.

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

Crashes come from the same pass that keeps the status column honest
(`services/status-reconcile.ts`), which is the only place in the panel that
learns a process went away *without being asked to*. They are already confirmed
across two readings, so a `pm2` that fails to answer for a moment sends nothing.

A manual deploy that succeeded is not announced, and that is deliberate: you are
already watching it, with the log streaming. A manual deploy that failed is,
because by then you have probably closed the tab.

### Why it does not bury you

Everything is **edge-triggered**: the crossing counts, not the state. "The disk
is at 8%" would be true every five minutes for a week; what gets announced is the
moment it crossed in, and later the moment it came back out. The disk threshold
carries two points of hysteresis, because a disk that is filling up sits exactly
on the threshold, and that is where a monitor without hysteresis starts
alternating alarm and all-clear forever.

On top of that there is a fifteen-minute silence per event and per subject: a
project under a restart policy that crash-loops would be reported on every sweep,
and the first message already says everything the twentieth would. Per subject
rather than globally, so one project flapping does not hide another falling over
at the same moment.

A panel update is announced when the target commit changes, not while an update
exists: the check runs every six hours and an unapplied update stays unapplied,
so the latter would be four messages a day about the same piece of news.

### When a notification cannot be sent

Nothing happens. `notify()` never throws, never blocks its caller and never makes
anything wait: a deploy does not fail because Telegram did not answer. A failed
send lands in the panel's log with the reason, translated where Telegram is
particularly cryptic — `chat not found` usually means you have not written to the
bot yet, and until you do, a bot cannot write to you.
