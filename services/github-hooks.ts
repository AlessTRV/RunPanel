import { githubRequest, parseRepoSlug, type RepoSlug } from "@/lib/github";
import { webhookPath, webhookUrl } from "@/lib/panel-url";

/**
 * The webhook on github.com that makes auto-deploy actually fire.
 *
 * Until now the panel printed a URL and a secret and asked the operator to
 * retype them into GitHub's form. Four separate things had to be got right by
 * hand — the URL, the secret, the content type, the event list — and getting
 * any of them wrong failed silently: a wrong secret is a 401 the panel refuses
 * to record, a form-encoded body was a 400, an unreachable URL never arrived at
 * all. None of the four is a decision. They are all determined by the project,
 * so the panel writes them itself and stops asking.
 *
 * Every operation here is idempotent and matched by URL rather than by stored
 * id, so a hook the operator already made by hand is adopted and corrected
 * instead of duplicated.
 */

/** GitHub's shape, narrowed to what the panel uses. */
interface RawHook {
  id: number;
  active?: boolean;
  events?: string[];
  config?: { url?: string; content_type?: string; insecure_ssl?: string | number };
  last_response?: { code?: number | null; status?: string | null; message?: string | null };
}

export interface HookInfo {
  /** Carried as a string: GitHub ids are int64, JS numbers are not. */
  id: string;
  active: boolean;
  url: string;
  contentType: string;
  events: string[];
  /** GitHub's own verdict on the last delivery it attempted. */
  lastResponse: { code: number | null; status: string | null; message: string | null } | null;
}

export interface HookDelivery {
  id: string;
  guid: string;
  event: string;
  deliveredAt: string;
  redelivery: boolean;
  status: string;
  statusCode: number | null;
}

/** Why a GitHub call could not do what was asked. */
export type HookProblem =
  | "no-token"
  | "not-github"
  | "no-public-url"
  | "unreachable-url"
  | "forbidden"
  | "not-found"
  | "rejected"
  | "network";

export interface HookFailure {
  ok: false;
  reason: HookProblem;
  message: string;
}

export type HookResult<T> = ({ ok: true } & T) | HookFailure;

function fail(reason: HookProblem, message: string): HookFailure {
  return { ok: false, reason, message };
}

/**
 * A GitHub status turned into something an operator can act on.
 *
 * 403 on this endpoint almost always means the token is fine but lacks hook
 * permission, which is a different fix from "the token is wrong" — so it says
 * which permission, by both token flavours, rather than echoing the status.
 */
async function problemFor(res: Response, slug: RepoSlug): Promise<HookFailure> {
  if (res.status === 401) {
    return fail("forbidden", "GitHub ha rifiutato il token: ricollegalo dalla pagina GitHub.");
  }
  if (res.status === 403) {
    return fail(
      "forbidden",
      "Il token non può gestire i webhook di questo repository. Serve lo scope repo (o write:repo_hook) su un token classico, oppure il permesso «Webhooks: Read and write» su uno fine-grained."
    );
  }
  if (res.status === 404) {
    return fail(
      "not-found",
      `Il token non vede ${slug.full}. Se il repository è di un'organizzazione, potrebbe servire autorizzare il token per quell'organizzazione.`
    );
  }
  if (res.status === 422) {
    // GitHub explains this one well enough to pass through — it is where
    // "url is not supported" for an address it will not deliver to lands.
    const detail = await res
      .json()
      .then((body: { message?: string }) => body?.message)
      .catch(() => null);
    return fail("rejected", `GitHub ha rifiutato la configurazione${detail ? `: ${detail}` : "."}`);
  }
  return fail("network", `GitHub ha risposto ${res.status}.`);
}

function toHookInfo(raw: RawHook): HookInfo {
  const last = raw.last_response;
  return {
    id: String(raw.id),
    active: raw.active !== false,
    url: raw.config?.url ?? "",
    contentType: raw.config?.content_type ?? "form",
    events: raw.events ?? [],
    lastResponse:
      last && (last.code != null || last.status || last.message)
        ? {
            code: last.code ?? null,
            status: last.status ?? null,
            message: last.message ?? null,
          }
        : null,
  };
}

/** The repository a project deploys from, or a reason there is not one. */
export function repoFor(project: {
  source_type: string;
  source_url: string | null;
}): HookResult<{ slug: RepoSlug }> {
  if (project.source_type !== "github") {
    return fail("not-github", "Il progetto non parte da un repository GitHub.");
  }
  const slug = parseRepoSlug(project.source_url);
  if (!slug) {
    return fail(
      "not-github",
      "L'URL del repository non è riconosciuto come github.com/utente/nome."
    );
  }
  return { ok: true, slug };
}

/**
 * This project's hook, found by the address it would deliver to.
 *
 * Matched on the path and not the whole URL on purpose: the panel may be
 * reached by more than one name over its life, and a hook written under the old
 * one is still this project's hook — it wants correcting, not a twin.
 */
export async function findHook(
  slug: RepoSlug,
  token: string,
  projectId: string
): Promise<HookResult<{ hook: HookInfo | null }>> {
  let res: Response;
  try {
    res = await githubRequest(`/repos/${slug.full}/hooks?per_page=100`, token);
  } catch {
    return fail("network", "Impossibile raggiungere GitHub.");
  }

  if (!res.ok) return problemFor(res, slug);

  const raw = (await res.json()) as RawHook[];
  const wanted = webhookPath(projectId);
  const mine = raw.find((hook) => (hook.config?.url ?? "").endsWith(wanted));

  return { ok: true, hook: mine ? toHookInfo(mine) : null };
}

/** One hook by id, or null when it is gone from GitHub. */
export async function getHook(
  slug: RepoSlug,
  token: string,
  hookId: string
): Promise<HookResult<{ hook: HookInfo | null }>> {
  let res: Response;
  try {
    res = await githubRequest(`/repos/${slug.full}/hooks/${encodeURIComponent(hookId)}`, token);
  } catch {
    return fail("network", "Impossibile raggiungere GitHub.");
  }

  // A deleted hook is not an error here: the stored id is a cache, and a miss
  // means the caller should look it up by URL instead.
  if (res.status === 404) return { ok: true, hook: null };
  if (!res.ok) return problemFor(res, slug);

  return { ok: true, hook: toHookInfo((await res.json()) as RawHook) };
}

interface EnsureInput {
  slug: RepoSlug;
  token: string;
  projectId: string;
  secret: string;
  origin: string;
  /** Skips the list call when the caller already knows the id. */
  knownHookId?: string | null;
}

/**
 * Create the hook, or bring an existing one back in line.
 *
 * The PATCH is unconditional rather than diffed first. The secret is the reason:
 * GitHub never returns it, so the panel cannot tell whether the hook it is
 * looking at carries the current one — and a hook with a stale secret looks
 * perfect in the listing and rejects every delivery. Rewriting is one request
 * and removes the entire question.
 */
export async function ensureHook(
  input: EnsureInput
): Promise<HookResult<{ hook: HookInfo; created: boolean }>> {
  const { slug, token, projectId, secret, origin, knownHookId } = input;

  const config = {
    url: webhookUrl(origin, projectId),
    content_type: "json",
    secret,
    insecure_ssl: "0",
  };

  let existing: HookInfo | null = null;

  if (knownHookId) {
    const byId = await getHook(slug, token, knownHookId);
    if (!byId.ok) return byId;
    existing = byId.hook;
  }

  if (!existing) {
    const found = await findHook(slug, token, projectId);
    if (!found.ok) return found;
    existing = found.hook;
  }

  const path = existing
    ? `/repos/${slug.full}/hooks/${encodeURIComponent(existing.id)}`
    : `/repos/${slug.full}/hooks`;

  let res: Response;
  try {
    res = await githubRequest(path, token, {
      method: existing ? "PATCH" : "POST",
      body: existing
        ? { active: true, events: ["push"], config }
        : { name: "web", active: true, events: ["push"], config },
    });
  } catch {
    return fail("network", "Impossibile raggiungere GitHub.");
  }

  if (!res.ok) return problemFor(res, slug);

  return {
    ok: true,
    hook: toHookInfo((await res.json()) as RawHook),
    created: existing === null,
  };
}

/**
 * Stop deliveries without destroying the hook.
 *
 * Deactivating rather than deleting keeps the delivery history on GitHub — the
 * record of what did and did not arrive, which is the first thing anyone looks
 * at when auto-deploy is turned back on and questioned.
 */
export async function disableHook(
  slug: RepoSlug,
  token: string,
  hookId: string
): Promise<HookResult<{ hook: HookInfo | null }>> {
  let res: Response;
  try {
    res = await githubRequest(`/repos/${slug.full}/hooks/${encodeURIComponent(hookId)}`, token, {
      method: "PATCH",
      body: { active: false },
    });
  } catch {
    return fail("network", "Impossibile raggiungere GitHub.");
  }

  // Already gone is the state that was wanted.
  if (res.status === 404) return { ok: true, hook: null };
  if (!res.ok) return problemFor(res, slug);

  return { ok: true, hook: toHookInfo((await res.json()) as RawHook) };
}

/**
 * Ask GitHub to send a real ping.
 *
 * The point of going through GitHub rather than having the panel post to itself:
 * a self-test proves the handler parses a body, which was never in doubt. This
 * one crosses DNS, the firewall, TLS and the signature — the parts that
 * actually break — and lands in the same "Recent Deliveries" list the operator
 * would otherwise be reading.
 */
export async function pingHook(
  slug: RepoSlug,
  token: string,
  hookId: string
): Promise<{ ok: true } | HookFailure> {
  let res: Response;
  try {
    res = await githubRequest(
      `/repos/${slug.full}/hooks/${encodeURIComponent(hookId)}/pings`,
      token,
      { method: "POST" }
    );
  } catch {
    return fail("network", "Impossibile raggiungere GitHub.");
  }

  if (!res.ok) return problemFor(res, slug);
  return { ok: true };
}

/**
 * What GitHub says it delivered, which is not what the panel says it received.
 *
 * The difference is the whole diagnostic: a delivery GitHub records as a
 * connection timeout never reached this process, so no amount of looking at the
 * panel's own history explains it.
 */
export async function listDeliveries(
  slug: RepoSlug,
  token: string,
  hookId: string,
  limit = 10
): Promise<HookResult<{ deliveries: HookDelivery[] }>> {
  let res: Response;
  try {
    res = await githubRequest(
      `/repos/${slug.full}/hooks/${encodeURIComponent(hookId)}/deliveries?per_page=${limit}`,
      token
    );
  } catch {
    return fail("network", "Impossibile raggiungere GitHub.");
  }

  if (!res.ok) return problemFor(res, slug);

  const raw = (await res.json()) as {
    id: number;
    guid: string;
    event: string;
    delivered_at: string;
    redelivery?: boolean;
    status: string;
    status_code: number;
  }[];

  return {
    ok: true,
    deliveries: raw.map((d) => ({
      id: String(d.id),
      guid: d.guid,
      event: d.event,
      deliveredAt: d.delivered_at,
      redelivery: Boolean(d.redelivery),
      status: d.status,
      statusCode: d.status_code ?? null,
    })),
  };
}
