import {
  SHARED_SETTING_KEYS,
  canonicalDirectory,
  exportDirectory,
  mergeDirectory,
  type DirectorySnapshot,
  type DirectoryUser,
  type SharedSetting,
  type Tombstone,
} from "@/lib/cluster-directory";
import { sha256Hex } from "@/lib/cluster-sign";
import { encrypt, tryDecrypt } from "@/lib/crypto";
import type { Transaction } from "kysely";

import { getDb, nowIso } from "@/lib/db";
import type { Database } from "@/lib/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { authzEvents } from "@/services/events";
import { clearCluster, clusterState, setClusterRole } from "./state";

/**
 * The replicated directory as this install holds it, and how a copy from
 * another member is folded in. The merge rules are in lib/cluster-directory.ts;
 * this file only reads and writes the store.
 */

/** `updated_at` of a shared setting, kept beside it under this key prefix. */
const SHARED_AT_PREFIX = "cluster_shared_at:";
/** Shared settings whose stored value is ciphertext. */
const ENCRYPTED_SHARED = new Set(["github_token", "telegram_bot_token"]);
/** What a value set before the install joined a cluster counts as: older than any edit since. */
const EPOCH = "1970-01-01T00:00:00.000Z";

export async function localSnapshot(): Promise<DirectorySnapshot> {
  const db = await getDb();
  // Old tombstones are pruned on the way out, so the set stays bounded (the
  // schema caps what a member accepts) and every member prunes the same way.
  await db
    .deleteFrom("cluster_tombstones")
    .where("deleted_at", "<", new Date(Date.now() - TOMBSTONE_TTL_MS).toISOString())
    .execute();
  const [users, permissions, grants, members, tombstones] = await Promise.all([
    db
      .selectFrom("users")
      .select(["id", "email", "password_hash", "is_owner", "disabled", "created_by", "created_at", "updated_at"])
      .execute(),
    db.selectFrom("user_permissions").select(["user_id", "permission"]).execute(),
    db.selectFrom("user_grants").select(["id", "user_id", "scope", "scope_id", "level", "terminal", "created_at"]).execute(),
    db.selectFrom("cluster_members").select(["id", "name", "url", "role", "created_at", "updated_at"]).execute(),
    db.selectFrom("cluster_tombstones").select(["kind", "id", "deleted_at"]).execute(),
  ]);

  const sharedSettings: SharedSetting[] = [];
  for (const key of SHARED_SETTING_KEYS) {
    const stored = await getSetting(key);
    const at = await getSetting(`${SHARED_AT_PREFIX}${key}`);
    if (stored === null && at === null) continue;
    let value: string | null = stored || null;
    if (value && ENCRYPTED_SHARED.has(key)) value = tryDecrypt(value);
    sharedSettings.push({ key, value, updated_at: at ?? EPOCH });
  }

  return exportDirectory({
    users,
    permissions,
    grants,
    members,
    tombstones: tombstones.filter((t): t is Tombstone => t.kind === "user" || t.kind === "member"),
    sharedSettings,
  });
}

export async function directoryHash(snapshot?: DirectorySnapshot): Promise<string> {
  return sha256Hex(canonicalDirectory(snapshot ?? (await localSnapshot())));
}

/** Write a shared setting the way its reader expects it, and stamp when. */
export async function writeSharedSetting(key: string, value: string | null, updatedAt = nowIso()): Promise<void> {
  const stored = value ? (ENCRYPTED_SHARED.has(key) ? encrypt(value) : value) : "";
  await setSetting(key, stored);
  await setSetting(`${SHARED_AT_PREFIX}${key}`, updatedAt);
}

/** Tombstones older than this are dropped: a copy that stale is not expected to come back. */
const TOMBSTONE_TTL_MS = 30 * 24 * 3_600_000;

/**
 * Note that a user or member was deleted here, so no stale copy brings it
 * back. Nothing to note in solo mode: there is no copy anywhere, and an
 * install only ever joins a cluster on its first run, with no users of its own.
 */
export async function tombstone(kind: "user" | "member", id: string): Promise<void> {
  if (!(await clusterState())) return;
  const db = await getDb();
  await db
    .insertInto("cluster_tombstones")
    .values({ kind, id, deleted_at: nowIso() })
    .onConflict((oc) => oc.columns(["kind", "id"]).doUpdateSet({ deleted_at: nowIso() }))
    .execute();
}

export interface ApplyResult {
  changedUserIds: string[];
  /** This install was revoked by the other side: it is now in solo mode. */
  revoked: boolean;
  /** The directory after the merge, to send back. */
  result: DirectorySnapshot;
}

/** Fold another member's copy into ours. Everything in one transaction. */
export async function applySnapshot(remote: DirectorySnapshot): Promise<ApplyResult> {
  const state = await clusterState();
  const local = await localSnapshot();
  const plan = mergeDirectory(local, remote);
  const db = await getDb();

  await db.transaction().execute(async (trx) => {
    for (const id of plan.users.remove) {
      await trx.deleteFrom("users").where("id", "=", id).execute();
    }

    // The owner is unique by a partial index: demote before promoting.
    for (const u of plan.users.upsert) {
      if (u.is_owner === 0) await trx.updateTable("users").set({ is_owner: 0 }).where("id", "=", u.id).execute();
    }
    for (const u of plan.users.upsert) {
      await upsertUser(trx, u);
    }

    for (const id of plan.members.remove) {
      await trx.deleteFrom("cluster_members").where("id", "=", id).execute();
    }
    for (const m of plan.members.upsert) {
      await trx
        .insertInto("cluster_members")
        .values({
          id: m.id,
          name: m.name,
          url: m.url,
          role: m.role,
          status: "unknown",
          version: null,
          last_seen_at: null,
          last_error: null,
          created_at: m.created_at,
          updated_at: m.updated_at,
        })
        .onConflict((oc) => oc.column("id").doUpdateSet({ name: m.name, url: m.url, role: m.role, updated_at: m.updated_at }))
        .execute();
    }

    for (const t of plan.tombstones) {
      await trx
        .insertInto("cluster_tombstones")
        .values({ kind: t.kind, id: t.id, deleted_at: t.deleted_at })
        .onConflict((oc) => oc.columns(["kind", "id"]).doUpdateSet({ deleted_at: t.deleted_at }))
        .execute();
    }
  });

  for (const s of plan.sharedSettings.upsert) {
    await writeSharedSetting(s.key, s.value, s.updated_at);
  }

  for (const id of plan.changedUserIds) authzEvents.emit(id, { type: "user-changed" });

  // Revoked by another member: back to solo, like /api/cluster/leave. A panel
  // keeps its sessions and its copy of the accounts; a node had no sessions.
  const revoked = state !== null && plan.members.remove.includes(state.selfId);
  if (revoked) {
    await clearCluster();
    if (state.role === "node") await db.deleteFrom("sessions").execute();
  } else if (state) {
    // Our own role may have been changed from another panel.
    const self = plan.result.members.find((m) => m.id === state.selfId);
    if (self && self.role !== state.role) {
      await setClusterRole(self.role === "node" ? "node" : "panel");
      if (self.role === "node") await db.deleteFrom("sessions").execute();
    }
  }

  return { changedUserIds: plan.changedUserIds, revoked, result: plan.result };
}

async function upsertUser(trx: Transaction<Database>, u: DirectoryUser): Promise<void> {
  await trx
    .insertInto("users")
    .values({
      id: u.id,
      email: u.email,
      password_hash: u.password_hash,
      is_owner: u.is_owner,
      disabled: u.disabled,
      created_by: u.created_by,
      created_at: u.created_at,
      last_login_at: null,
      updated_at: u.updated_at,
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        email: u.email,
        password_hash: u.password_hash,
        is_owner: u.is_owner,
        disabled: u.disabled,
        created_by: u.created_by,
        updated_at: u.updated_at,
      })
    )
    .execute();

  await trx.deleteFrom("user_permissions").where("user_id", "=", u.id).execute();
  await trx.deleteFrom("user_grants").where("user_id", "=", u.id).execute();
  if (u.permissions.length > 0) {
    await trx
      .insertInto("user_permissions")
      .values(u.permissions.map((permission) => ({ user_id: u.id, permission })))
      .execute();
  }
  if (u.grants.length > 0) {
    await trx
      .insertInto("user_grants")
      .values(
        u.grants.map((g) => ({
          id: g.id,
          user_id: u.id,
          scope: g.scope,
          scope_id: g.scope_id,
          level: g.level,
          terminal: g.terminal,
          created_at: g.created_at,
        }))
      )
      .execute();
  }
}
