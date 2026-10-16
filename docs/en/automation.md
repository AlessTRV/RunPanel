[← RunPanel](../../README.md) · [Italiano](../it/automation.md) · **English**

---

# Deploy automation

It is set in the project's **Impostazioni** (settings) tab, **Deploy automatico** section. The *Come parte il deploy* (how the deploy starts) field picks one of two ways:

- **Webhook**: GitHub notifies on every push and the deploy starts at once. The server must be reachable from the internet.
- **Controllo periodico** (polling): RunPanel asks GitHub at intervals and deploys when the commit changes. Outbound requests only: it works behind NAT, a VPN or Tailscale.

Picking one turns the other off, because two active transports would deploy the same commit twice. Both follow the project's branch; a project pinned to a commit ignores them (see [Going back to a commit](#going-back-to-a-commit)).

## Webhook

Every project has its own webhook URL and secret. Signatures are verified with HMAC-SHA256; every delivery, accepted or refused, goes into the history with the reason.

With the **GitHub token** connected, turning auto-deploy on **registers the webhook by itself** on the repository (`push` event, `application/json`). Turning it off disables it without deleting it. A webhook created by hand with the same URL is recognised and corrected, not duplicated. To manage webhooks the token needs the `repo` or `write:repo_hook` scope (classic token) or the *Webhooks: Read and write* permission (fine-grained token); an organisation's repository may need it authorised. Without a token, URL and secret are there to copy for a manual setup.

The section says what is wrong: missing token, unrecognised repository, an address GitHub cannot reach, a mismatched webhook, a refused last delivery. It shows the last 10 deliveries received and the last 10 seen by GitHub; history is kept for 30 days. **Invia ping** asks GitHub for a real delivery, which goes through DNS, firewall, TLS and signature. If the project is stuck in "deploying", every push answers "queued" and nothing happens: the **Sblocca** (unlock) button frees it.

The address the panel writes to GitHub is **Indirizzo pubblico** (public address) under **Impostazioni › Pannello** (owner only). Left empty it is taken from the request, which only works if you open the panel at the same address GitHub reaches it at. With [several servers](multi-server.md) the webhook goes to the server hosting the project: set the public address on each server, with that server selected, and note that a server with the node role must also be reachable from the internet to receive webhooks.

> **Reachable only over a VPN or Tailscale?** Webhooks will not arrive: GitHub delivers from the internet. A `100.64–100.127.x.x` address is refused outright; a MagicDNS `*.ts.net` name is flagged, because it only works when published with `tailscale funnel`. Use polling.

## Polling

It needs the GitHub token connected and a repository on `github.com`: without a token it does not run and the section shows it in red.

The interval is set under **Impostazioni › Pannello** (owner only), from 30 seconds to 30 minutes, 5 minutes by default. A branch that has not moved costs a `304 Not Modified` response, which GitHub does not count against the hourly limit. A deploy starts at most one interval plus about fifteen seconds after the push. With several servers each server polls its own projects at its own interval, all with the same shared token.

The first round after turning it on **records** the current commit without deploying it: what arrives next is deployed. Each new commit gets one attempt: if its deploy fails, it is not retried until another commit arrives. Deploys started this way show in the history with the `poll` trigger. If the last check is older than three intervals, the section turns amber.

## Going back to a commit

The button next to **Deploy** opens the repository history: pick branch and commit, then **Distribuisci** (deploy). Use it when the latest commit broke the app.

The choice **sticks**: every deploy rebuilds that commit, the header says so and auto-deploy is suspended. Deliveries arriving meanwhile stay in the history as ignored. **Torna all'ultimo commit** (back to the latest commit), in the **Altro** menu, releases the pin and deploys the head of the branch. Changing the branch in the settings releases it too.

Picking another branch in the history changes the project's branch, which it follows from then on. The commit list comes from the GitHub API and needs the token; without it, or for a commit older than the last hundred, paste the full 40-character SHA.

**Database migrations do not roll back.** A version that expects an older schema may not start; the panel reminds you before going ahead.

## One-time commands

Contract commands run on every deploy. One-time commands run once, at the step you pick, then leave the queue: a migration to run now, a `git submodule update`, a permissions fix. They are written under **Impostazioni › Comandi una tantum** and need the **Accesso all'host** permission. While the queue is not empty, the number of waiting commands shows next to the project's name.

| Step | When | Docker | Compose | Native |
|---|---|---|---|---|
| Prima del deploy (before the deploy) | Before anything is touched; the old app is running | host | host | host |
| Dopo il git (after git) | New commit on disk, variables loaded | host | host | host |
| Prima dell'install (before install) | Right before dependencies | — | — | host |
| Dopo l'install (after install) | Dependencies installed, no build yet | — | — | host |
| Dopo il build (after build) | Build succeeded, before the release command | container | host | host |
| Prima dell'avvio (before start) | Old process stopped, new one not started | container | host | host |
| Dopo l'avvio (after start) | Process started, health check not passed yet | container | host | host |
| A deploy riuscito (on success) | Health check passed | container | host | host |

With Docker and Compose, install and build are one step, so the two steps around install do not exist; on a static project they run one after the other right before the build. Under Docker the steps after the build use a throwaway container from the image just built, with the same network, mounts and environment as the release command. With Compose they always run on the host: to enter a service, write `docker compose run --rm api sh -c '…'`. If you change runtime and a queued command no longer has a valid step, it stays queued and flagged, and the deploy log says why it did not run.

**If a command fails, the deploy fails** and the command stays queued for the next deploy, with attempts and error visible. With *Continua anche se fallisce* (continue on failure) the deploy goes on and the command is consumed, recorded as failed. A successful command goes into the history (step, duration, commit), which is cleared by hand or by itself after 90 days. A failure in *A deploy riuscito* marks the deploy failed even if the app is alive and healthy.

Limits: 10 minutes per command, 50 commands queued, 4000 characters per command. The queue is taken at the start of a deploy: a command added during a deploy is for the next one, and the queue cannot be edited while a deploy holds it.

They are kept out of the [deploy contract](deploy.md#the-deploy-contract) because the contract is merged with the repository's `runpanel.json`: there they would be host commands chosen by anyone who can push. Do not put passwords in them: the command ends up in the log.

Execution is **at least once**: if the panel restarts while a command runs, the command goes back to the queue and runs again, and the interrupted run is flagged.
