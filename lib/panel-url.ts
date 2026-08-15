import { getSetting } from "./settings";
import { isBlockedRepoHost } from "./validation";

/**
 * Where the panel is, as seen from outside the machine it runs on.
 *
 * Nothing needed this before. Every absolute URL the panel produced was built
 * in the browser from `window.location.origin`, which is right for a link
 * someone clicks and wrong for the one thing that has to work without a
 * browser: the address GitHub posts a webhook to. Registering that hook happens
 * on the server, so the server has to know its own address, and it has no way
 * to learn one — a request's `Host` header is whatever the client sent, and
 * behind a reverse proxy that is the proxy's idea of the name, not necessarily
 * a name that resolves from the internet.
 *
 * So: the operator's answer if there is one, the request's otherwise, and in
 * both cases an honest verdict about whether GitHub could reach it.
 */

export const PANEL_PUBLIC_URL_SETTING = "panel_public_url";

export interface PanelBaseUrl {
  /** Origin with no trailing slash, e.g. `https://panel.esempio.it`. */
  origin: string;
  /** The operator configured this, or it was read off the current request. */
  source: "setting" | "request";
  /** False for loopback and private literals — GitHub cannot deliver there. */
  reachable: boolean;
  /**
   * A Tailscale MagicDNS name. Reachable from the internet only while Funnel is
   * on, and there is no way to tell from here which it is — so it is flagged
   * rather than judged.
   */
  tailnet: boolean;
  host: string;
}

/**
 * Tailscale addresses, which are the interesting case.
 *
 * A tailnet is a private network that behaves like a public one from the
 * inside: the panel opens over HTTPS on a real domain name with a real
 * certificate, and every check short of asking someone outside says it is
 * fine. GitHub is not on the tailnet, so it is not fine — the delivery fails
 * at connect, before any of this code runs, which is exactly the silence this
 * feature exists to end.
 *
 * The `100.64/10` literals are already refused as carrier-grade NAT by the
 * shared predicate. The names are not, and must not be: `tailscale funnel`
 * publishes the same `*.ts.net` name to the internet, and then it genuinely
 * works. So this reports the ambiguity instead of resolving it.
 */
function isTailnetHost(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(".ts.net");
}

function describe(raw: string, source: PanelBaseUrl["source"]): PanelBaseUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  return {
    origin: url.origin,
    source,
    reachable: !isBlockedRepoHost(url.hostname),
    tailnet: isTailnetHost(url.hostname),
    host: url.host,
  };
}

/**
 * `request` is optional so a caller with no request in hand — a background job,
 * a future scheduler — still gets the configured value rather than nothing.
 */
export async function panelBaseUrl(request?: Request): Promise<PanelBaseUrl | null> {
  const configured = (await getSetting(PANEL_PUBLIC_URL_SETTING))?.trim();
  if (configured) {
    const parsed = describe(configured, "setting");
    if (parsed) return parsed;
    // A stored value that no longer parses is not a reason to give up: fall
    // through and answer from the request, which is at least true right now.
  }

  if (!request) return null;

  const headers = request.headers;
  const host = headers.get("x-forwarded-host")?.split(",")[0].trim() || headers.get("host");
  if (!host) return null;

  const proto =
    headers.get("x-forwarded-proto")?.split(",")[0].trim() ||
    (request.url.startsWith("https:") ? "https" : "http");

  return describe(`${proto}://${host}`, "request");
}

/** The address a project's webhook is delivered to. One spelling, one place. */
export function webhookPath(projectId: string): string {
  return `/api/webhooks/github/${projectId}`;
}

export function webhookUrl(origin: string, projectId: string): string {
  return `${origin.replace(/\/+$/, "")}${webhookPath(projectId)}`;
}
