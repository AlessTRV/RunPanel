import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { githubToken } from "@/lib/github";
import { panelBaseUrl } from "@/lib/panel-url";
import {
  disableHook,
  ensureHook,
  findHook,
  pingHook,
  repoFor,
  type HookProblem,
} from "./github-hooks";
import { primePollBaseline } from "./deploy-poll";

/**
 * Register, test and retire a project's webhook on GitHub.
 *
 * The layer between the raw API calls in `github-hooks.ts` and the two callers
 * that want them: the explicit buttons on the settings tab, and the auto-deploy
 * toggle, which does the same work without being asked.
 *
 * Everything here answers rather than throws. Turning auto-deploy on is a
 * setting the operator changed and a request to a third party over the
 * internet, and those two must not share a fate — a token without hook
 * permission, or an organisation that has not authorised it, cannot be allowed
 * to make the switch itself refuse to move.
 */

export interface ManageResult {
  ok: boolean;
  message: string;
  reason?: HookProblem;
}

function no(reason: HookProblem, message: string): ManageResult {
  return { ok: false, reason, message };
}

async function rememberHookId(projectId: string, hookId: string | null): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("projects")
    .set({ github_hook_id: hookId, updated_at: nowIso() })
    .where("id", "=", projectId)
    .execute();
}

/** Create the hook or bring it back in line, and remember which one it is. */
export async function connectWebhook(
  project: ProjectsTable,
  request?: Request
): Promise<ManageResult> {
  const repo = repoFor(project);
  if (!repo.ok) return no(repo.reason, repo.message);

  const token = await githubToken();
  if (!token) {
    return no(
      "no-token",
      "Nessun token GitHub collegato: registra il webhook a mano, oppure collega GitHub dal pannello."
    );
  }

  const base = await panelBaseUrl(request);
  if (!base) {
    return no(
      "no-public-url",
      "Il pannello non conosce il proprio indirizzo pubblico. Impostalo nelle impostazioni."
    );
  }
  if (!base.reachable) {
    return no(
      "unreachable-url",
      `GitHub non può consegnare a ${base.host}: è un indirizzo privato o locale. Imposta l'indirizzo pubblico del pannello nelle impostazioni.`
    );
  }

  const result = await ensureHook({
    slug: repo.slug,
    token,
    projectId: project.id,
    secret: project.webhook_secret,
    origin: base.origin,
    knownHookId: project.github_hook_id,
  });

  if (!result.ok) return no(result.reason, result.message);

  await rememberHookId(project.id, result.hook.id);

  return {
    ok: true,
    message: result.created
      ? `Webhook creato su ${repo.slug.full}.`
      : `Webhook di ${repo.slug.full} aggiornato.`,
  };
}

/**
 * Ask GitHub to deliver a ping.
 *
 * Answers 200 without waiting for the delivery to land: GitHub queues it, and
 * the result shows up in the next status read from both sides — the panel's own
 * history and GitHub's.
 */
export async function pingWebhook(project: ProjectsTable): Promise<ManageResult> {
  const repo = repoFor(project);
  if (!repo.ok) return no(repo.reason, repo.message);

  const token = await githubToken();
  if (!token) return no("no-token", "Serve un token GitHub collegato per inviare un ping.");

  let hookId = project.github_hook_id;
  if (!hookId) {
    const found = await findHook(repo.slug, token, project.id);
    if (!found.ok) return no(found.reason, found.message);
    if (!found.hook) {
      return no("not-found", "Nessun webhook da testare: collegalo prima.");
    }
    hookId = found.hook.id;
    await rememberHookId(project.id, hookId);
  }

  const result = await pingHook(repo.slug, token, hookId);
  if (!result.ok) return no(result.reason, result.message);

  return { ok: true, message: "Ping inviato: GitHub sta consegnando." };
}

/**
 * Stop the deliveries, keep the hook.
 *
 * Deleting it would take its delivery history on GitHub with it — the record of
 * what arrived and what did not, which is exactly what gets read the next time
 * someone doubts that auto-deploy works.
 */
export async function disconnectWebhook(project: ProjectsTable): Promise<ManageResult> {
  const repo = repoFor(project);
  if (!repo.ok) return no(repo.reason, repo.message);

  const token = await githubToken();
  if (!token) return no("no-token", "Serve un token GitHub collegato per disattivare il webhook.");

  let hookId = project.github_hook_id;
  if (!hookId) {
    const found = await findHook(repo.slug, token, project.id);
    if (!found.ok) return no(found.reason, found.message);
    if (!found.hook) return { ok: true, message: "Nessun webhook da disattivare." };
    hookId = found.hook.id;
  }

  const result = await disableHook(repo.slug, token, hookId);
  if (!result.ok) return no(result.reason, result.message);

  // The hook is gone from GitHub — drop the id so the next read looks properly
  // rather than chasing one that no longer exists.
  if (!result.hook) await rememberHookId(project.id, null);

  return { ok: true, message: "Webhook disattivato su GitHub." };
}

/**
 * Follow the auto-deploy settings onto GitHub, without being able to block them.
 *
 * Called after the columns are already written, and it decides by transport:
 * a project on webhooks wants its hook created and kept in line, a project on
 * polling wants that hook quiet and a baseline commit recorded so the first
 * tick does not read "nothing seen yet" as "everything is new".
 *
 * A failure comes back as a message the settings tab shows as a warning next to
 * a switch that did move — the webhook stays configurable by hand, and the copy
 * fields for URL and secret are still right there.
 */
export async function syncAutoDeploy(
  project: ProjectsTable,
  request?: Request
): Promise<ManageResult | null> {
  if (project.source_type !== "github") return null;

  // No account connected is not a warning worth raising here: the operator
  // never asked the panel to manage anything on GitHub, and the settings tab
  // already says so under "Nessun token GitHub".
  if (!(await githubToken())) return null;

  const enabled = Boolean(project.auto_deploy);
  const polling = project.deploy_trigger === "poll";

  try {
    if (polling) {
      // The hook is deactivated rather than left running: two transports for one
      // project would deploy the same commit twice, once per path.
      const quieted = await disconnectWebhook(project);
      if (enabled) await primePollBaseline(project);
      // A repository whose hook was never created has nothing to quieten, and
      // saying so would be noise on a switch that worked.
      return quieted.ok || quieted.reason === "not-found" ? null : quieted;
    }

    return enabled ? await connectWebhook(project, request) : await disconnectWebhook(project);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Errore imprevisto";
    console.error(`[webhook] Sync failed for ${project.slug}:`, err);
    return no("network", `Il webhook non è stato aggiornato: ${message}`);
  }
}
