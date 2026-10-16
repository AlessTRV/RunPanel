import type { ClusterMembersTable } from "@/lib/db/schema";
import { signedFetch } from "./client";
import { recordMemberSeen } from "./state";

/**
 * Handing a member the cluster secret.
 *
 * Used by the rotation, which sends the new secret signed with the one being
 * retired, and by "Reinvia il segreto", which sends the current secret to a
 * member that missed a rotation, signed with the previous one it still knows.
 */

export interface SecretPushResult {
  memberId: string;
  name: string;
  ok: boolean;
  error?: string;
}

export async function pushSecret(
  member: Pick<ClusterMembersTable, "id" | "name" | "url">,
  secret: string,
  signWith?: string
): Promise<SecretPushResult> {
  try {
    const res = await signedFetch(member, "/api/cluster/secret", {
      method: "POST",
      body: JSON.stringify({ secret }),
      contentType: "application/json",
      headersTimeoutMs: 8_000,
      ...(signWith ? { secret: signWith } : {}),
    });
    if (res.ok) return { memberId: member.id, name: member.name, ok: true };
    const error = res.status === 401 ? "Firma rifiutata: il server non conosce più il segreto precedente" : `HTTP ${res.status}`;
    await recordMemberSeen(member.id, { error });
    return { memberId: member.id, name: member.name, ok: false, error };
  } catch (err) {
    return { memberId: member.id, name: member.name, ok: false, error: err instanceof Error ? err.message : "Errore" };
  }
}

/** Push to every member, then try once more, after a short pause, those that failed. */
export async function pushSecretToAll(
  members: Array<Pick<ClusterMembersTable, "id" | "name" | "url">>,
  secret: string,
  retryDelayMs = 3_000
): Promise<SecretPushResult[]> {
  const first = await Promise.all(members.map((m) => pushSecret(m, secret)));
  const failed = members.filter((m) => !first.find((r) => r.memberId === m.id)?.ok);
  if (failed.length === 0) return first;

  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  const retried = await Promise.all(failed.map((m) => pushSecret(m, secret)));
  return first.map((r) => retried.find((x) => x.memberId === r.memberId) ?? r);
}
