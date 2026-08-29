[← RunPanel](../../README.en.md) · [Italiano](../it/automation.md) · **English**

---

# Deploy automation

## Automatic deploys

Every project has a webhook URL with a secret of its own. With **Auto-deploy**
on, a push to the configured branch starts a deploy. Signatures are verified with
HMAC-SHA256 and a constant-time compare; deliveries, accepted or rejected, stay
in the history with the reason.

With a GitHub account connected the webhook **registers itself**: flipping the
switch creates it on the repository with the URL, the secret, the
`application/json` content type and the `push` event alone already set. Turning
auto-deploy off deactivates the hook rather than deleting it, so its delivery
history on GitHub survives.

The section also says what is wrong: no token, an unrecognised repository, a
panel address GitHub cannot reach, a misconfigured hook, a refused last
delivery. **Send ping** asks GitHub for a real delivery, across DNS, the
firewall, TLS and the signature.

So the panel knows which address to write into GitHub, set **Public address**
under Account → Preferences. Left empty it is derived from the request, which
holds as long as you open the panel on the same address GitHub reaches it by.

> **Panel only reachable over a VPN or Tailscale?** Then webhooks never arrive:
> GitHub delivers from the internet and is not on your private network. A
> `100.64–100.127.x.x` address is refused outright; a `*.ts.net` MagicDNS name
> is flagged, because it works **only** if you publish it with
> `tailscale funnel`. You do not have to expose anything: use **polling** below.

## Polling, for a panel nothing can reach

A webhook needs GitHub to open a connection *to* this machine, and behind NAT, on
a Tailscale or WireGuard network, on a laptop, it cannot: the delivery fails
before it arrives and nothing shows up in the logs, because the problem is the
direction of the connection.

So the panel can **ask** instead of being told. In the project's settings, under
*Deploy automatico → Come parte il deploy*:

- **Webhook** — GitHub calls on every push and the deploy starts at once.
  Requires a panel reachable from the internet.
- **Polling** — RunPanel reads the branch on a timer and deploys when the commit
  changes. One outbound request, none inbound: it works anywhere with an
  internet connection.

The interval lives under Account → Preferences, from 30 seconds to 30 minutes
(5 minutes by default). An unchanged branch answers `304 Not Modified` thanks to
the ETag, and GitHub does not count 304s against the hourly rate limit — even 30
seconds costs practically nothing. A deploy is delayed by at most one interval.

The first pass after switching **records** the current commit without deploying
it — "deploy what comes next", not "deploy whatever is there now" — and deploys
started this way appear in the history with the `poll` trigger. Choosing polling
deactivates any webhook, since two live transports would deploy the same commit
twice.

The hook stays configurable by hand — the URL and secret are right there — for
repositories the token cannot administer, or a panel with no account connected.

## Going back to a specific commit

The button next to **Deploy** opens the repository's history: pick the branch,
pick the commit, and the project is rebuilt from there. It is for when the commit
that just went out is the one that broke the app.

The choice **holds**. The project stops at that commit: every deploy rebuilds it,
the header says so with a badge, and **auto-deploy is suspended** rather than
carrying the project forward on the next push. Deliveries that arrive meanwhile
stay in the history as ignored, with the reason. **Back to the latest commit**
releases the hold and deploys the branch head again.

Choosing a different branch here changes the project's branch: from then on it is
the one the webhook and the poller follow. The commit list comes from the GitHub
API, so it wants a connected account; without one, or for a commit older than the
last hundred, there is a field to paste a SHA into.

The panel repeats this before going ahead: **database migrations do not roll
back**. If the restored version expects an older schema than the one that is
there, it may not start.

## One-time commands

The contract's commands run on *every* deploy. One-time commands run once, at the
point of the sequence you pick, and then leave the queue: the migration you need
now, a `git submodule update` after changing repository, a permissions fix, a
cache purge. You write them in **Settings → Comandi una tantum**, and while the
queue is not empty the panel says so next to the Deploy button.

| Step | When | Docker | Native and Compose |
|---|---|---|---|
| Before the deploy | Before anything is touched; the old app is still up | host | host |
| After git | New commit on disk, env loaded, nothing installed yet | host | host |
| Before install | Immediately before the dependencies | — | host |
| After install | Dependencies installed, build not run yet | — | host |
| After build | Build succeeded, before the release command | container | host |
| Before start | Old process stopped, new one not started | container | host |
| After start | Process started, health check not passed yet | container | host |
| On success | Health check passed | container | host |

The two steps around the install do not exist under Docker and Compose: there,
install and build are a single `docker build`. Changing a project's runtime does
not delete a command queued on one of them — it stays, flagged, and the deploy
log says why it did not run.

Where a command runs is decided by the step, not by an option: under Docker the
steps after the build use a throwaway container from the freshly built image —
same network, same mounts, same environment, like the release command — while the
two before the build run on the host. Under Compose everything runs on the host,
and reaching one service means writing it out
(`docker compose run --rm api sh -c '…'`).

**If one fails, the deploy fails** and the command **stays queued**: fix the cause
and the next deploy retries it, with the attempt count and the last error in view.
Tick *Continua anche se fallisce* and the deploy carries on, consuming the command
anyway and recording it as failed. Whatever succeeds leaves the queue for the
history, with its step, duration and commit; you can empty that by hand, and it
collects itself after 90 days.

One warning about *On success*: a command failing there marks the deploy failed
**even though the app is alive and healthy**: it is the one step where "failed"
does not mean "not serving".

**They are not part of the deploy contract, and that is not an oversight.** The
contract is merged with the repository's `runpanel.json`, so a field there would be
arbitrary shell on the host that anyone able to push could run. They live in a
table of their own, where nothing is merged and the only writer is an
authenticated route: a repository cannot reach them. Do not put passwords in them: the command ends up in the
deploy log.

Execution is **at least once**, not exactly once: if the panel restarts while a
command is running, that command goes back in the queue and will run again, and
the interrupted row is flagged.
