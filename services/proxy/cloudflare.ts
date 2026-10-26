import { getDb, nowIso } from "@/lib/db";
import { encrypt, tryDecrypt } from "@/lib/crypto";
import { getSetting, setSetting } from "@/lib/settings";
import { zoneFor } from "@/lib/proxy-names";

/**
 * The Cloudflare account behind some of the domains: the API token the
 * operator pasted, the zones it can see, and which domains are among them.
 *
 * Being linked is a column, not a question put to Cloudflare at apply time, so
 * nginx and the renewals keep working while Cloudflare's API is down; only the
 * list on the Domains page and the requests for new certificates wait for it.
 */

export const CLOUDFLARE_TOKEN_SETTING = "proxy_cloudflare_token";

const API = "https://api.cloudflare.com/client/v4";
/** The page polls every 10 seconds; an account's zones change about never. */
const ZONES_TTL_MS = 60_000;

export interface CloudflareZone {
  id: string;
  name: string;
  /** `active` once the domain's nameservers point at Cloudflare, `pending` until then. */
  status: string;
}

export type ZonesOutcome = { zones: CloudflareZone[]; error: null } | { zones: null; error: string };

const globalRef = globalThis as typeof globalThis & {
  __runpanelCloudflareZones?: { token: string; at: number; outcome: ZonesOutcome };
  __runpanelCloudflareReading?: { token: string; reading: Promise<ZonesOutcome> };
};

/** The stored token, or null — also when it was encrypted under a secret this panel no longer has. */
export async function cloudflareToken(): Promise<string | null> {
  const stored = await getSetting(CLOUDFLARE_TOKEN_SETTING);
  return stored ? tryDecrypt(stored) : null;
}

/** Store a token that just listed `zones`, which become the held reading. */
export async function saveCloudflareToken(token: string, zones: CloudflareZone[]): Promise<void> {
  await setSetting(CLOUDFLARE_TOKEN_SETTING, encrypt(token));
  globalRef.__runpanelCloudflareZones = { token, at: Date.now(), outcome: { zones, error: null } };
}

export async function forgetCloudflareToken(): Promise<void> {
  const db = await getDb();
  await db.deleteFrom("settings").where("key", "=", CLOUDFLARE_TOKEN_SETTING).execute();
  globalRef.__runpanelCloudflareZones = undefined;
}

/** Cloudflare's own words for a refusal, and what to check when it is the token. */
function refusal(status: number, body: { errors?: { message?: string }[] } | null): string {
  const said = (body?.errors ?? [])
    .map((error) => error.message)
    .filter(Boolean)
    .join("; ");
  if (status === 400 || status === 401 || status === 403) {
    return `Cloudflare rifiuta il token${said ? ` (${said})` : ""}: serve un API Token, non la Global API Key, con i permessi Zone · Zone · Read e Zone · DNS · Edit.`;
  }
  return `Cloudflare ha risposto ${status}${said ? `: ${said}` : ""}.`;
}

/** Every zone the token can see, a page at a time. Throws with the reason to show. */
export async function listZones(token: string): Promise<CloudflareZone[]> {
  const zones: CloudflareZone[] = [];
  for (let page = 1; page <= 20; page++) {
    let res: Response;
    try {
      res = await fetch(`${API}/zones?per_page=50&page=${page}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
    } catch (err) {
      throw new Error(`Cloudflare non risponde: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success || !Array.isArray(body.result)) throw new Error(refusal(res.status, body));
    for (const zone of body.result) {
      zones.push({ id: String(zone.id), name: String(zone.name).toLowerCase(), status: String(zone.status) });
    }
    if (page >= Number(body.result_info?.total_pages ?? 1)) break;
  }
  return zones.sort((a, b) => a.name.localeCompare(b.name));
}

/** One reading of the zones at a time per token; a refusal is kept as an answer too. */
function readZones(token: string): Promise<ZonesOutcome> {
  const running = globalRef.__runpanelCloudflareReading;
  if (running?.token === token) return running.reading;
  const reading = listZones(token)
    .then(
      (zones): ZonesOutcome => ({ zones, error: null }),
      (err: unknown): ZonesOutcome => ({ zones: null, error: err instanceof Error ? err.message : String(err) })
    )
    .then((outcome) => {
      globalRef.__runpanelCloudflareZones = { token, at: Date.now(), outcome };
      return outcome;
    })
    .finally(() => {
      if (globalRef.__runpanelCloudflareReading?.reading === reading) globalRef.__runpanelCloudflareReading = undefined;
    });
  globalRef.__runpanelCloudflareReading = { token, reading };
  return reading;
}

/**
 * The token's zones. Past a minute the held reading is still the answer and a
 * new one is taken behind it, so a slow Cloudflare never holds up the page's
 * poll; `fresh` is the button, and waits for a reading taken now.
 */
export async function cloudflareZones(token: string, fresh = false): Promise<ZonesOutcome> {
  const held = globalRef.__runpanelCloudflareZones;
  if (fresh || !held || held.token !== token) return readZones(token);
  if (Date.now() - held.at >= ZONES_TTL_MS) void readZones(token);
  return held.outcome;
}

/**
 * Mark each domain by whether its zone is one of `zones`: the account's active
 * ones, or none once the token is gone. Returns whether anything changed and
 * which domains this call linked.
 */
export async function linkDomains(zones: readonly string[]): Promise<{ changed: boolean; linked: string[] }> {
  const db = await getDb();
  const rows = await db.selectFrom("domains").select(["id", "name", "cloudflare"]).execute();
  const linked: string[] = [];
  let changed = false;
  for (const row of rows) {
    const cloudflare = zoneFor(row.name, zones) ? 1 : 0;
    if (cloudflare === row.cloudflare) continue;
    changed = true;
    if (cloudflare === 1) linked.push(row.id);
    await db.updateTable("domains").set({ cloudflare, updated_at: nowIso() }).where("id", "=", row.id).execute();
  }
  return { changed, linked };
}
