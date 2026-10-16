import { randomBytes } from "node:crypto";
import type { MemberStatus } from "@/lib/cluster-merge";
import { signedFetch } from "./client";
import { clusterState, listMembers } from "./state";

/**
 * Ask every member of the cluster, this one included, the same question as
 * the signed-in user, in parallel, and keep whatever comes back.
 *
 * Each member answers with its own copy of the user's permissions, exactly as
 * if the page had called it directly through /api/nodes. A member that is
 * down, slow or refuses is reported in `members` with the reason; it never
 * fails the whole answer.
 */

export interface FanOutResult<T> {
  member: { id: string; name: string; self: boolean };
  ok: boolean;
  status: number | null;
  data: T | null;
  error: string | null;
}

export async function fanOut<T>(
  path: string,
  opts: { userId: string; timeoutMs?: number }
): Promise<FanOutResult<T>[]> {
  const state = await clusterState();
  if (!state) return [];
  const members = await listMembers();

  return Promise.all(
    members.map(async (m): Promise<FanOutResult<T>> => {
      const member = { id: m.id, name: m.name, self: m.id === state.selfId };
      try {
        // A random parameter makes every signature unique: two tabs polling the
        // same list in the same millisecond would otherwise send identical
        // signatures, and the second would be refused as a replay.
        const nonce = randomBytes(6).toString("hex");
        const target = `${path}${path.includes("?") ? "&" : "?"}_n=${nonce}`;
        const res = await signedFetch(m, target, { userId: opts.userId, headersTimeoutMs: opts.timeoutMs ?? 5_000 });
        if (!res.ok) {
          let error = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body.error === "string") error = body.error;
          } catch {
            /* not JSON */
          }
          return { member, ok: false, status: res.status, data: null, error };
        }
        return { member, ok: true, status: res.status, data: (await res.json()) as T, error: null };
      } catch (err) {
        return { member, ok: false, status: null, data: null, error: err instanceof Error ? err.message : "Errore" };
      }
    })
  );
}

/** The per-member part of an aggregated answer. */
export function memberStatuses<T>(results: FanOutResult<T>[]): MemberStatus[] {
  return results.map((r) => ({
    id: r.member.id,
    name: r.member.name,
    self: r.member.self,
    ok: r.ok,
    // A 403 is an answer, not an outage: the user simply may not see that part there.
    reachable: r.status !== null,
    error: r.error,
  }));
}
