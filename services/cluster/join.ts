import { audit } from "@/lib/audit";
import { joinResponseSchema, type LinkSetup } from "@/lib/cluster-schema";
import { pingMember } from "./client";
import { applySnapshot } from "./directory";
import { adoptCluster, clearCluster, clusterState } from "./state";

/**
 * A fresh install asking an existing panel to let it in.
 *
 * Outbound only: the new install calls the panel, so it never needs to be
 * reachable from anywhere before it chooses to be. The panel answers with the
 * cluster secret and the directory; from then on both sides speak signed
 * requests and the panel calls back.
 */

export type JoinOutcome = { ok: true; role: "panel" | "node" } | { ok: false; status: number; error: string };

export async function joinCluster(link: LinkSetup, version: string): Promise<JoinOutcome> {
  if (await clusterState()) return { ok: false, status: 409, error: "Questo server fa già parte di un cluster" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${link.panelUrl}/api/cluster/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link.token, name: link.name, url: link.url, role: link.role, version }),
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "nessuna risposta entro 15 secondi" : "connessione fallita";
    return { ok: false, status: 502, error: `Il pannello ${link.panelUrl} non risponde: ${reason}` };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 403 || res.status === 404) {
    return { ok: false, status: 403, error: "Token di collegamento mancante, scaduto o già usato" };
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = String(((await res.json()) as { error?: unknown }).error ?? "");
    } catch {
      /* not JSON */
    }
    return { ok: false, status: 502, error: `Il pannello ha risposto ${res.status}${detail ? `: ${detail}` : ""}` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, status: 502, error: "Risposta del pannello non leggibile" };
  }
  const parsed = joinResponseSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, status: 502, error: "Risposta del pannello non riconosciuta: versioni diverse?" };

  const adopted = await adoptCluster({
    clusterId: parsed.data.clusterId,
    selfId: parsed.data.memberId,
    secret: parsed.data.secret,
    role: link.role,
  });
  if (!adopted) return { ok: false, status: 409, error: "Questo server fa già parte di un cluster" };

  // Membership is only real once the accounts are here: with `cluster_id`
  // set and no users, nobody could sign in and setup could not be repeated.
  try {
    await applySnapshot(parsed.data.directory);
  } catch (err) {
    await clearCluster().catch(() => undefined);
    return { ok: false, status: 500, error: `Directory non applicabile: ${err instanceof Error ? err.message : "errore"}` };
  }

  const panel = parsed.data.directory.members.find((m) => m.id === parsed.data.panelId);
  if (panel) await pingMember(panel);

  await audit({
    userId: null,
    category: "security",
    action: "cluster.linked",
    detail: `${link.role} → ${link.panelUrl}`,
  });
  return { ok: true, role: link.role };
}
