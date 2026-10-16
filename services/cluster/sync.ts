import { directorySchema } from "@/lib/cluster-schema";
import type { ClusterMembersTable } from "@/lib/db/schema";
import { MemberUnreachableError, pingMember, signedFetch } from "./client";
import { applySnapshot, directoryHash, localSnapshot } from "./directory";
import { clusterState, listMembers, recordMemberSeen } from "./state";

/**
 * Keeping every member's copy of the directory the same.
 *
 * Two mechanisms, both best-effort:
 *
 *   broadcast  right after a local change: push our snapshot to every other
 *              member and fold in what each sends back. Debounced, so a form
 *              that saves three things sends one push.
 *   poller     every minute: ping each member, compare directory hashes and
 *              exchange snapshots only when they differ. This is what repairs
 *              a push that found a member down.
 *
 * A managed node pushes too: a grant edited through a panel on a project it
 * holds is written on the node, and it is the node's copy that has to reach
 * the others before a later edit elsewhere replaces it.
 */

const POLL_MS = 60_000;
const FIRST_POLL_MS = 20_000;
const DEBOUNCE_MS = 500;

export interface MemberSyncResult {
  memberId: string;
  ok: boolean;
  error?: string;
}

/** Push our snapshot to one member and apply what it sends back. */
export async function syncWithMember(member: Pick<ClusterMembersTable, "id" | "url" | "role">): Promise<MemberSyncResult> {
  const state = await clusterState();
  if (!state) return { memberId: member.id, ok: false, error: "Nessun cluster" };

  try {
    const ping = await pingMember(member);
    if (!ping) {
      const fresh = (await listMembers()).find((m) => m.id === member.id);
      return { memberId: member.id, ok: false, error: fresh?.last_error ?? "Nessuna risposta" };
    }
    if (ping.clusterId !== state.clusterId) {
      await recordMemberSeen(member.id, { error: "Fa parte di un altro cluster" });
      return { memberId: member.id, ok: false, error: "Fa parte di un altro cluster" };
    }
    const snapshot = await localSnapshot();
    if ((await directoryHash(snapshot)) === ping.directoryHash) return { memberId: member.id, ok: true };

    const res = await signedFetch(member, "/api/cluster/directory", {
      method: "POST",
      body: JSON.stringify(snapshot),
      contentType: "application/json",
      headersTimeoutMs: 15_000,
    });
    if (!res.ok) {
      const error = `HTTP ${res.status} allo scambio della directory`;
      await recordMemberSeen(member.id, { error });
      return { memberId: member.id, ok: false, error };
    }
    const parsed = directorySchema.safeParse(await res.json());
    if (!parsed.success) {
      const error = "Directory ricevuta non valida";
      await recordMemberSeen(member.id, { error });
      return { memberId: member.id, ok: false, error };
    }
    await applySnapshot(parsed.data);
    return { memberId: member.id, ok: true };
  } catch (err) {
    const error = err instanceof MemberUnreachableError ? err.message : err instanceof Error ? err.message : "Errore";
    return { memberId: member.id, ok: false, error };
  }
}

/** One pass over every other member. */
export async function syncTick(): Promise<MemberSyncResult[]> {
  const state = await clusterState();
  if (!state) return [];
  const members = (await listMembers()).filter((m) => m.id !== state.selfId);
  return Promise.all(members.map((m) => syncWithMember(m)));
}

const ref = globalThis as typeof globalThis & {
  __runpanelClusterTimer?: NodeJS.Timeout;
  __runpanelClusterBroadcast?: { timer?: NodeJS.Timeout; running?: Promise<MemberSyncResult[]> };
};

/**
 * Push the directory to everyone, soon. Fire-and-forget by default; `wait`
 * returns the outcome, for a route that wants to report it. A call that
 * arrives while a push is in flight runs its own push after it.
 */
export function broadcastDirectory(opts: { wait?: boolean } = {}): Promise<MemberSyncResult[]> {
  const slot = (ref.__runpanelClusterBroadcast ??= {});

  const run = (): Promise<MemberSyncResult[]> => {
    // A push in flight does not carry what was just written: queue one after it.
    if (slot.running) return slot.running.then(() => run());
    slot.running = syncTick()
      .catch(() => [] as MemberSyncResult[])
      .finally(() => {
        slot.running = undefined;
      });
    return slot.running;
  };

  if (opts.wait) {
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = undefined;
    }
    return run();
  }

  if (!slot.timer) {
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      void run();
    }, DEBOUNCE_MS);
    slot.timer.unref?.();
  }
  return Promise.resolve([]);
}

export function startClusterSync(): void {
  if (ref.__runpanelClusterTimer) return;
  const tick = () => {
    void syncTick().catch(() => undefined);
  };
  const first = setTimeout(() => {
    tick();
    ref.__runpanelClusterTimer = setInterval(tick, POLL_MS);
    ref.__runpanelClusterTimer.unref?.();
  }, FIRST_POLL_MS);
  first.unref?.();
  ref.__runpanelClusterTimer = first;
}
