import { randomBytes } from "node:crypto";

import { encrypt, tryDecrypt } from "@/lib/crypto";
import { getDb, nowIso } from "@/lib/db";
import type { ClusterMembersTable } from "@/lib/db/schema";
import { getSetting, setSetting, setSettingIfAbsent } from "@/lib/settings";
import { generateId } from "@/lib/utils";
import type { MemberRole } from "@/lib/cluster-schema";

/**
 * What this install knows about the cluster it belongs to.
 *
 * Everything lives in `settings` and `cluster_members`. An install that never
 * linked anything has no `cluster_id`, and `clusterState()` returns null:
 * that is "solo mode", and every caller treats it as "behave as before".
 *
 * The secret is shared by every member and encrypted at rest with this
 * install's own key. A rotation keeps the previous one for a grace period so
 * members that have not heard yet are not cut off mid-request.
 */

export const CLUSTER_ID_SETTING = "cluster_id";
export const CLUSTER_SELF_ID_SETTING = "cluster_self_id";
export const CLUSTER_SECRET_SETTING = "cluster_secret";
export const CLUSTER_SECRET_PREVIOUS_SETTING = "cluster_secret_previous";
export const CLUSTER_SECRET_ROTATED_AT_SETTING = "cluster_secret_rotated_at";
export const CLUSTER_ROLE_SETTING = "cluster_role";

/** How long a rotated-out secret is still accepted. */
export const SECRET_GRACE_MS = 10 * 60_000;

export interface ClusterState {
  clusterId: string;
  selfId: string;
  role: MemberRole;
  secret: string;
  /** The secret before the last rotation, while still inside the grace period. */
  previousSecret: string | null;
}

export function newSecret(): string {
  return randomBytes(32).toString("hex");
}

export async function clusterState(): Promise<ClusterState | null> {
  const clusterId = await getSetting(CLUSTER_ID_SETTING);
  if (!clusterId) return null;
  const selfId = await getSetting(CLUSTER_SELF_ID_SETTING);
  const stored = await getSetting(CLUSTER_SECRET_SETTING);
  const secret = stored ? tryDecrypt(stored) : null;
  if (!selfId || !secret) return null;

  const role = (await getSetting(CLUSTER_ROLE_SETTING)) === "node" ? "node" : "panel";

  let previousSecret: string | null = null;
  const rotatedAt = await getSetting(CLUSTER_SECRET_ROTATED_AT_SETTING);
  if (rotatedAt && Date.now() - Date.parse(rotatedAt) < SECRET_GRACE_MS) {
    const prev = await getSetting(CLUSTER_SECRET_PREVIOUS_SETTING);
    previousSecret = prev ? tryDecrypt(prev) : null;
  }

  return { clusterId, selfId, role, secret, previousSecret };
}

/** Whether this install is a managed node with no UI of its own. */
export async function isNodeOnly(): Promise<boolean> {
  return (await getSetting(CLUSTER_ROLE_SETTING)) === "node";
}

/**
 * Start a cluster with this install as its first panel, or return the one it
 * is already in. The id is claimed with `setSettingIfAbsent`, so two requests
 * creating the first link token together do not make two clusters.
 */
export async function ensureCluster(self: { name: string; url: string }): Promise<ClusterState> {
  const existing = await clusterState();
  if (existing) return existing;

  const clusterId = generateId();
  const selfId = generateId();
  const secret = newSecret();
  const claimed = await setSettingIfAbsent(CLUSTER_ID_SETTING, clusterId);
  if (!claimed) {
    const state = await clusterState();
    if (state) return state;
    throw new Error("Stato del cluster incompleto");
  }
  await setSetting(CLUSTER_SELF_ID_SETTING, selfId);
  await setSetting(CLUSTER_SECRET_SETTING, encrypt(secret));
  await setSetting(CLUSTER_ROLE_SETTING, "panel");

  const now = nowIso();
  const db = await getDb();
  await db
    .insertInto("cluster_members")
    .values({
      id: selfId,
      name: self.name,
      url: self.url,
      role: "panel",
      status: "ok",
      version: null,
      last_seen_at: now,
      last_error: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();

  return { clusterId, selfId, role: "panel", secret, previousSecret: null };
}

/** Adopt the cluster a panel just let us into. Only for an install that is not in one. */
export async function adoptCluster(p: { clusterId: string; selfId: string; secret: string; role: MemberRole }): Promise<boolean> {
  const claimed = await setSettingIfAbsent(CLUSTER_ID_SETTING, p.clusterId);
  if (!claimed) return false;
  await setSetting(CLUSTER_SELF_ID_SETTING, p.selfId);
  await setSetting(CLUSTER_SECRET_SETTING, encrypt(p.secret));
  await setSetting(CLUSTER_ROLE_SETTING, p.role);
  return true;
}

export async function setClusterRole(role: MemberRole): Promise<void> {
  await setSetting(CLUSTER_ROLE_SETTING, role);
}

/** Install a new shared secret, keeping the old one for the grace period. */
export async function installSecret(secret: string): Promise<void> {
  const current = await getSetting(CLUSTER_SECRET_SETTING);
  if (current) {
    const plain = tryDecrypt(current);
    if (plain === secret) return;
    await setSetting(CLUSTER_SECRET_PREVIOUS_SETTING, current);
    await setSetting(CLUSTER_SECRET_ROTATED_AT_SETTING, nowIso());
  }
  await setSetting(CLUSTER_SECRET_SETTING, encrypt(secret));
}

export async function listMembers(): Promise<ClusterMembersTable[]> {
  const db = await getDb();
  return db.selectFrom("cluster_members").selectAll().orderBy("name").execute();
}

export async function getMember(id: string): Promise<ClusterMembersTable | null> {
  const db = await getDb();
  return (await db.selectFrom("cluster_members").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
}

/** Record what a call to (or from) a member just taught us about it. */
export async function recordMemberSeen(
  id: string,
  p: { version?: string | null; error?: string | null }
): Promise<void> {
  const db = await getDb();
  const now = nowIso();
  if (p.error) {
    await db
      .updateTable("cluster_members")
      .set({ status: "unreachable", last_error: p.error.slice(0, 300) })
      .where("id", "=", id)
      .execute();
    return;
  }
  await db
    .updateTable("cluster_members")
    .set({
      status: "ok",
      last_seen_at: now,
      last_error: null,
      ...(p.version !== undefined ? { version: p.version } : {}),
    })
    .where("id", "=", id)
    .execute();
}

/** Forget the cluster entirely: back to solo mode. The replicated users stay. */
export async function clearCluster(): Promise<void> {
  const db = await getDb();
  await db.deleteFrom("cluster_members").execute();
  await db.deleteFrom("cluster_link_tokens").execute();
  await db.deleteFrom("cluster_tombstones").execute();
  await db
    .deleteFrom("settings")
    .where("key", "in", [
      CLUSTER_ID_SETTING,
      CLUSTER_SELF_ID_SETTING,
      CLUSTER_SECRET_SETTING,
      CLUSTER_SECRET_PREVIOUS_SETTING,
      CLUSTER_SECRET_ROTATED_AT_SETTING,
      CLUSTER_ROLE_SETTING,
    ])
    .execute();
}
