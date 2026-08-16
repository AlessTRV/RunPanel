import { getDb } from "@/lib/db";
import type { DeployTrigger, ProjectsTable } from "@/lib/db/schema";
import { githubToken } from "@/lib/github";
import { panelBaseUrl, webhookUrl, type PanelBaseUrl } from "@/lib/panel-url";
import type { Check } from "./diagnostics";
import {
  findHook,
  getHook,
  listDeliveries,
  repoFor,
  type HookDelivery,
  type HookInfo,
} from "./github-hooks";
import { pollIntervalLabel, pollIntervalSeconds } from "./deploy-poll";

/**
 * One place that knows whether a project's webhook works.
 *
 * Written for the same reason `diagnostics.ts` is: the settings tab, the button
 * that registers the hook and the answer after a ping all have to agree about
 * what is wrong, and three opinions computed in three places is how a panel
 * ends up contradicting itself.
 *
 * It reports rather than repairs — the caller decides whether to act — and it
 * answers with the diagnostics `Check` vocabulary, whose contract is that a
 * problem is never stated without the thing that fixes it.
 */

export interface PanelDelivery {
  id: string;
  status: string;
  receivedAt: string;
  deploymentId: string | null;
  summary: Record<string, unknown>;
}

export interface WebhookStatus {
  autoDeploy: boolean;
  /** Which transport carries a push to this project. */
  trigger: DeployTrigger;
  poll: {
    /** Seconds between branch checks, from the panel-wide preference. */
    intervalSeconds: number;
    /** The same, spelled for a reader: "30 secondi", "5 minuti". */
    intervalLabel: string;
    lastCheckedAt: string | null;
    /** The commit the poller last saw on the branch. */
    sha: string | null;
  };
  /** `owner/name`, when the project deploys from GitHub. */
  repo: string | null;
  /** A GitHub account is connected to the panel. */
  connected: boolean;
  baseUrl: PanelBaseUrl | null;
  /** The address GitHub should post to, once one can be worked out. */
  url: string | null;
  hook: HookInfo | null;
  /** Why GitHub could not be asked, when it could not. */
  hookError: string | null;
  deliveries: PanelDelivery[];
  githubDeliveries: HookDelivery[];
  checks: Check[];
}

const RECENT = 10;

function parseSummary(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What the panel itself recorded, newest first. */
async function panelDeliveries(projectId: string): Promise<PanelDelivery[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("webhook_deliveries")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("received_at", "desc")
    .limit(RECENT)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    receivedAt: row.received_at,
    deploymentId: row.deployment_id,
    summary: parseSummary(row.payload_summary),
  }));
}

export async function webhookStatus(
  project: ProjectsTable,
  request?: Request
): Promise<WebhookStatus> {
  const autoDeploy = Boolean(project.auto_deploy);
  const repo = repoFor(project);
  const token = await githubToken();
  const base = await panelBaseUrl(request);
  const trigger: DeployTrigger = project.deploy_trigger === "poll" ? "poll" : "webhook";
  const pollSeconds = await pollIntervalSeconds();

  const status: WebhookStatus = {
    autoDeploy,
    trigger,
    poll: {
      intervalSeconds: pollSeconds,
      intervalLabel: pollIntervalLabel(pollSeconds),
      lastCheckedAt: project.poll_checked_at,
      sha: project.poll_sha,
    },
    repo: repo.ok ? repo.slug.full : null,
    connected: Boolean(token),
    baseUrl: base,
    url: base ? webhookUrl(base.origin, project.id) : null,
    hook: null,
    hookError: null,
    deliveries: await panelDeliveries(project.id),
    githubDeliveries: [],
    checks: [],
  };

  // Ask GitHub about the hook only when a hook is what carries the deploys.
  // Under polling there is nothing on GitHub to be right or wrong.
  if (repo.ok && token && trigger === "webhook") {
    const found = project.github_hook_id
      ? await getHook(repo.slug, token, project.github_hook_id)
      : await findHook(repo.slug, token, project.id);

    if (!found.ok) {
      status.hookError = found.message;
    } else if (found.hook) {
      status.hook = found.hook;
    } else if (project.github_hook_id) {
      // The cached id pointed at a hook that is gone. Look again by URL before
      // concluding there is none — the operator may have rebuilt it by hand.
      const byUrl = await findHook(repo.slug, token, project.id);
      if (!byUrl.ok) status.hookError = byUrl.message;
      else status.hook = byUrl.hook;
    }

    if (status.hook) {
      const deliveries = await listDeliveries(repo.slug, token, status.hook.id, RECENT);
      if (deliveries.ok) status.githubDeliveries = deliveries.deliveries;
    }
  }

  status.checks = buildChecks(project, status);
  return status;
}

function buildChecks(project: ProjectsTable, status: WebhookStatus): Check[] {
  const checks: Check[] = [];
  const settingsHref = `/projects/${project.id}?tab=settings`;

  const polling = status.trigger === "poll";

  if (project.source_type !== "github") {
    checks.push({
      id: "source",
      title: "Il progetto non parte da GitHub",
      tone: "neutral",
      detail: "L'auto-deploy vale solo per i progetti collegati a un repository.",
      href: settingsHref,
    });
    return checks;
  }

  /*
    First, because it overrides every answer below it.

    A pinned project is held at a commit on purpose, and while it is held nothing
    here deploys: the webhook files its deliveries as ignored and the poller does
    not consider the project at all. Reported before the rest so the section
    cannot show a row of green checks over an auto-deploy that will not fire.
  */
  if (project.pinned_sha) {
    checks.push({
      id: "pinned",
      title: `Progetto fermo su ${project.pinned_sha.slice(0, 7)}`,
      tone: "warn",
      detail: "L'auto-deploy è sospeso finché il progetto resta fermo su questo commit.",
      href: `/projects/${project.id}?tab=deployments`,
    });
  }

  checks.push(
    status.repo
      ? {
          id: "repo",
          title: `Repository ${status.repo}`,
          tone: "ok",
          detail: `Branch ${project.source_branch}.`,
        }
      : {
          id: "repo",
          title: "Repository non riconosciuto",
          tone: "danger",
          detail: polling
            ? "L'URL del progetto non è nella forma github.com/utente/nome, quindi il pannello non sa quale branch controllare."
            : "L'URL del progetto non è nella forma github.com/utente/nome, quindi il pannello non sa su quale repository registrare il webhook.",
          href: settingsHref,
        }
  );

  checks.push(
    status.connected
      ? {
          id: "token",
          title: "Account GitHub collegato",
          tone: "ok",
          detail: polling
            ? "Il pannello può leggere il branch per conto suo."
            : "Il pannello può creare e verificare il webhook da solo.",
        }
      : {
          id: "token",
          title: "Nessun token GitHub",
          tone: polling ? "danger" : "warn",
          detail: polling
            ? "Il controllo periodico interroga l'API di GitHub, quindi senza token non parte."
            : "Senza token il webhook va creato a mano su GitHub, con l'URL e il Secret qui sotto.",
          href: "/github",
        }
  );

  /*
    Polling stops here.

    Everything below is about a hook: an address GitHub has to reach, a
    configuration on the repository, deliveries that did or did not arrive. None
    of it exists when the panel is the one asking, and reporting it anyway would
    be the panel raising alarms about a mechanism it is not using — which is how
    a diagnostic screen stops being read.
  */
  if (polling) {
    const stale =
      status.poll.lastCheckedAt !== null &&
      staleBy(status.poll.lastCheckedAt, status.poll.intervalSeconds);

    checks.push(
      project.pinned_sha
        ? // Before the staleness branch, and that is the point: while the
          // project is held the poller skips it and deliberately leaves
          // `poll_checked_at` where it was — so the timestamp goes stale by
          // design, and reporting "il pannello potrebbe essere stato fermo"
          // would blame an outage for something the operator asked for.
          {
            id: "poll",
            title: "Controllo periodico sospeso",
            tone: "neutral",
            detail: "Riprende quando il progetto non è più fermo su un commit.",
          }
        : !status.autoDeploy
        ? {
            id: "poll",
            title: `Controllo ogni ${status.poll.intervalLabel}`,
            tone: "neutral",
            detail: "Parte quando attivi l'auto-deploy.",
          }
        : !status.poll.lastCheckedAt
          ? {
              id: "poll",
              title: "Primo controllo non ancora eseguito",
              tone: "neutral",
              detail:
                "Il poller parte poco dopo l'avvio del pannello. Il primo giro registra il commit attuale senza distribuirlo: si distribuisce dal push successivo.",
            }
          : {
              id: "poll",
              title: `Controllato ${relative(status.poll.lastCheckedAt)}`,
              tone: stale ? "warn" : "ok",
              detail: stale
                ? "Più vecchio dell'intervallo: il pannello potrebbe essere stato fermo, o GitHub non risponde."
                : `Ogni ${status.poll.intervalLabel}${
                    status.poll.sha ? `, ultimo commit visto ${status.poll.sha.slice(0, 7)}` : ""
                  }.`,
            }
    );

    if (project.status === "deploying") checks.push(stuckCheck(project));
    return checks;
  }

  if (!status.baseUrl) {
    checks.push({
      id: "public-url",
      title: "Indirizzo pubblico sconosciuto",
      tone: "warn",
      detail: "Imposta l'indirizzo da cui il pannello è raggiungibile, così GitHub sa dove scrivere.",
      href: "/settings",
    });
  } else if (!status.baseUrl.reachable) {
    checks.push({
      id: "public-url",
      title: `GitHub non può raggiungere ${status.baseUrl.host}`,
      tone: "danger",
      detail:
        status.baseUrl.source === "setting"
          ? "L'indirizzo pubblico configurato è privato o locale: le consegne non arriveranno mai. Un indirizzo 100.64–100.127.x.x è una VPN tipo Tailscale, e GitHub non ne fa parte."
          : "Stai aprendo il pannello su un indirizzo locale. Imposta l'indirizzo pubblico nelle impostazioni, altrimenti l'URL del webhook vale solo da questa rete.",
      href: "/settings",
    });
  } else if (status.baseUrl.tailnet) {
    /*
      A tailnet looks exactly like the internet from inside it — real name, real
      certificate, everything green — and GitHub is not on it. The panel cannot
      tell whether Funnel is publishing this name publicly, so it says which
      case it needs rather than guessing.
    */
    checks.push({
      id: "public-url",
      title: `${status.baseUrl.host} è un indirizzo Tailscale`,
      tone: "warn",
      detail:
        "GitHub non fa parte del tuo tailnet: le consegne arrivano solo se questo nome è pubblicato con Tailscale Funnel (tailscale funnel 3000). Altrimenti serve un altro ingresso pubblico — un tunnel o una porta esposta — da mettere qui come indirizzo pubblico.",
      href: "/settings",
    });
  } else {
    checks.push({
      id: "public-url",
      title: `Raggiungibile su ${status.baseUrl.host}`,
      tone: "ok",
      detail:
        status.baseUrl.source === "setting"
          ? "Indirizzo pubblico configurato."
          : "Dedotto da questa richiesta. Impostalo nelle impostazioni per fissarlo.",
    });
  }

  if (status.hookError) {
    checks.push({
      id: "hook",
      title: "GitHub non ha risposto come previsto",
      tone: "danger",
      detail: status.hookError,
      href: "/github",
    });
  } else if (!status.connected || !status.repo) {
    // Nothing to say about the hook that the two checks above have not said.
  } else if (!status.hook) {
    checks.push({
      id: "hook",
      title: "Webhook non presente sul repository",
      tone: status.autoDeploy ? "danger" : "neutral",
      detail: status.autoDeploy
        ? "L'auto-deploy è attivo ma nessun webhook consegna a questo progetto."
        : "Si crea da solo quando attivi l'auto-deploy.",
      ...(status.autoDeploy
        ? { fix: { label: "Collega", endpoint: `/api/projects/${project.id}/webhook`, body: { action: "connect" } } }
        : {}),
    });
  } else {
    const problems: string[] = [];
    if (!status.hook.active) problems.push("è disattivato");
    if (status.hook.contentType !== "json") problems.push(`invia ${status.hook.contentType}`);
    if (!status.hook.events.includes("push")) problems.push("non ascolta l'evento push");

    checks.push(
      problems.length
        ? {
            id: "hook",
            title: "Webhook da riallineare",
            tone: status.autoDeploy ? "warn" : "neutral",
            detail: `Il webhook su GitHub ${problems.join(", ")}.`,
            fix: {
              label: "Riallinea",
              endpoint: `/api/projects/${project.id}/webhook`,
              body: { action: "connect" },
            },
          }
        : {
            id: "hook",
            title: "Webhook attivo su GitHub",
            tone: "ok",
            detail: "Content type JSON, solo evento push.",
            fix: {
              label: "Invia ping",
              endpoint: `/api/projects/${project.id}/webhook`,
              body: { action: "ping" },
            },
          }
    );

    const last = status.hook.lastResponse;
    if (last && last.code != null && (last.code < 200 || last.code >= 300)) {
      checks.push({
        id: "last-delivery",
        title: `Ultima consegna rifiutata (${last.code})`,
        tone: "danger",
        detail: last.message || last.status || "GitHub non ha ricevuto una risposta valida.",
        fix: {
          label: "Riprova",
          endpoint: `/api/projects/${project.id}/webhook`,
          body: { action: "ping" },
        },
      });
    }
  }

  if (project.status === "deploying") checks.push(stuckCheck(project));

  return checks;
}

/**
 * A project left in `deploying` answers every push with a cheerful 200 "queued"
 * and builds nothing: the queue's claim is a conditional UPDATE that refuses to
 * start while the status says a deploy is running, and only a restart clears
 * it. It is indistinguishable from a broken trigger from the outside, so it is
 * named here — with the Stop that already resets it.
 */
function stuckCheck(project: ProjectsTable): Check {
  return {
    id: "stuck",
    title: "Il progetto risulta in deploy",
    tone: "warn",
    detail:
      "Finché resta in questo stato ogni push viene messo in coda e non parte. Se non c'è davvero un deploy in corso, fermalo per sbloccarlo.",
    fix: {
      label: "Sblocca",
      endpoint: `/api/projects/${project.id}/control`,
      body: { action: "stop" },
    },
  };
}

/**
 * A check older than three intervals means the poller is not running — the
 * panel was down, or GitHub has been refusing it. Three rather than one so a
 * tick that lands a few seconds late is not reported as a fault, and never
 * under a minute, or a thirty-second interval would cry stale over one slow
 * response.
 */
function staleBy(iso: string, intervalSeconds: number): boolean {
  const last = Date.parse(iso);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last > Math.max(intervalSeconds * 3, 60) * 1000;
}

/** Server-side relative time, in the panel's vocabulary. */
function relative(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "pochi secondi fa";
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `${minutes} minut${minutes === 1 ? "o" : "i"} fa`;
  }
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3600);
    return `${hours} or${hours === 1 ? "a" : "e"} fa`;
  }
  const days = Math.round(seconds / 86_400);
  return `${days} giorn${days === 1 ? "o" : "i"} fa`;
}
