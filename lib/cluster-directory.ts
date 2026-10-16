/**
 * The replicated directory: what every cluster member agrees on.
 *
 * Users (with their permissions and grants), the member list, a few shared
 * settings and the tombstones of what was deleted. Any panel may edit any of
 * it; copies converge by merging per record:
 *
 *   - a tombstone wins over a record changed at or before the deletion
 *   - otherwise the record with the newer `updated_at` wins
 *   - on an exact tie the smaller canonical serialisation wins, so both sides
 *     pick the same one whichever direction the merge runs
 *   - when a user record wins, its permissions and grants replace the other
 *     side's set wholesale; they are not merged field by field
 *
 * `bumpedUpdatedAt` keeps a member's own edits strictly after what it has
 * already merged, so a clock that is behind cannot lose a change it just made.
 *
 * Zero imports: the unit suite loads this file directly.
 */

export interface DirectoryGrant {
  id: string;
  scope: string;
  scope_id: string;
  level: string;
  terminal: number;
  created_at: string;
}

export interface DirectoryUser {
  id: string;
  email: string | null;
  password_hash: string | null;
  is_owner: number;
  disabled: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  permissions: string[];
  grants: DirectoryGrant[];
}

export interface DirectoryMember {
  id: string;
  name: string;
  url: string;
  role: string;
  created_at: string;
  updated_at: string;
}

export type TombstoneKind = "user" | "member";

export interface Tombstone {
  kind: TombstoneKind;
  id: string;
  deleted_at: string;
}

/** A setting every member shares. `value` is the plaintext; each member encrypts it at rest with its own key. */
export interface SharedSetting {
  key: string;
  value: string | null;
  updated_at: string;
}

export interface DirectorySnapshot {
  users: DirectoryUser[];
  members: DirectoryMember[];
  tombstones: Tombstone[];
  sharedSettings: SharedSetting[];
}

export const SHARED_SETTING_KEYS = ["github_token", "telegram_bot_token", "telegram_chat_id"] as const;
export type SharedSettingKey = (typeof SHARED_SETTING_KEYS)[number];

export function isSharedSettingKey(key: string): key is SharedSettingKey {
  return (SHARED_SETTING_KEYS as readonly string[]).includes(key);
}

export interface DirectoryRows {
  users: Array<Omit<DirectoryUser, "permissions" | "grants" | "updated_at"> & { updated_at: string | null }>;
  permissions: Array<{ user_id: string; permission: string }>;
  grants: Array<DirectoryGrant & { user_id: string }>;
  members: DirectoryMember[];
  tombstones: Tombstone[];
  sharedSettings: SharedSetting[];
}

/** Group flat store rows into a snapshot, with everything in a stable order. */
export function exportDirectory(rows: DirectoryRows): DirectorySnapshot {
  const permissions = new Map<string, string[]>();
  for (const p of rows.permissions) {
    const list = permissions.get(p.user_id) ?? [];
    list.push(p.permission);
    permissions.set(p.user_id, list);
  }
  const grants = new Map<string, DirectoryGrant[]>();
  for (const g of rows.grants) {
    const list = grants.get(g.user_id) ?? [];
    list.push({ id: g.id, scope: g.scope, scope_id: g.scope_id, level: g.level, terminal: g.terminal, created_at: g.created_at });
    grants.set(g.user_id, list);
  }
  const users = rows.users.map((u) =>
    normalizeUser({
      id: u.id,
      email: u.email,
      password_hash: u.password_hash,
      is_owner: u.is_owner,
      disabled: u.disabled,
      created_by: u.created_by,
      created_at: u.created_at,
      updated_at: u.updated_at ?? u.created_at,
      permissions: permissions.get(u.id) ?? [],
      grants: grants.get(u.id) ?? [],
    })
  );
  return normalizeSnapshot({ users, members: rows.members, tombstones: rows.tombstones, sharedSettings: rows.sharedSettings });
}

function normalizeUser(u: DirectoryUser): DirectoryUser {
  return {
    id: u.id,
    email: u.email,
    password_hash: u.password_hash,
    is_owner: u.is_owner ? 1 : 0,
    disabled: u.disabled ? 1 : 0,
    created_by: u.created_by,
    created_at: u.created_at,
    updated_at: u.updated_at,
    permissions: [...new Set(u.permissions)].sort(),
    grants: [...u.grants]
      .map((g) => ({ id: g.id, scope: g.scope, scope_id: g.scope_id, level: g.level, terminal: g.terminal ? 1 : 0, created_at: g.created_at }))
      .sort(byId),
  };
}

function normalizeMember(m: DirectoryMember): DirectoryMember {
  return { id: m.id, name: m.name, url: m.url, role: m.role, created_at: m.created_at, updated_at: m.updated_at };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function normalizeSnapshot(s: DirectorySnapshot): DirectorySnapshot {
  return {
    users: s.users.map(normalizeUser).sort(byId),
    members: s.members.map(normalizeMember).sort(byId),
    tombstones: dedupeTombstones(s.tombstones),
    sharedSettings: s.sharedSettings
      .map((x) => ({ key: x.key, value: x.value, updated_at: x.updated_at }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  };
}

function dedupeTombstones(list: Tombstone[]): Tombstone[] {
  const map = new Map<string, Tombstone>();
  for (const t of list) {
    const key = `${t.kind}:${t.id}`;
    const prev = map.get(key);
    if (!prev || prev.deleted_at < t.deleted_at) map.set(key, { kind: t.kind, id: t.id, deleted_at: t.deleted_at });
  }
  return [...map.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : byId(a, b)));
}

/** A stable string for hashing: same content, same order, same text on every member. */
export function canonicalDirectory(s: DirectorySnapshot): string {
  return stableStringify(normalizeSnapshot(s));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The `updated_at` for an edit made now: strictly after whatever this record
 * already carried, even when the local clock is behind the member it was last
 * merged from.
 */
export function bumpedUpdatedAt(previous: string | null | undefined, now: string): string {
  if (!previous) return now;
  const prev = Date.parse(previous);
  const cur = Date.parse(now);
  if (!Number.isFinite(prev)) return now;
  if (!Number.isFinite(cur) || cur > prev) return now;
  return new Date(prev + 1).toISOString();
}

export interface MergePlan {
  users: { upsert: DirectoryUser[]; remove: string[] };
  members: { upsert: DirectoryMember[]; remove: string[] };
  sharedSettings: { upsert: SharedSetting[] };
  /** The union of both sides' tombstones: what to store. */
  tombstones: Tombstone[];
  /** Users whose access changed in any way — open streams re-check them. */
  changedUserIds: string[];
  /** The directory as it stands after the plan is applied. */
  result: DirectorySnapshot;
}

/** What `local` must do to converge with `remote`. Pure: nothing is applied here. */
export function mergeDirectory(localRaw: DirectorySnapshot, remoteRaw: DirectorySnapshot): MergePlan {
  const local = normalizeSnapshot(localRaw);
  const remote = normalizeSnapshot(remoteRaw);
  const tombstones = dedupeTombstones([...local.tombstones, ...remote.tombstones]);
  const deletedAt = new Map(tombstones.map((t) => [`${t.kind}:${t.id}`, t.deleted_at]));

  const users = mergeRecords("user", local.users, remote.users, deletedAt);
  const members = mergeRecords("member", local.members, remote.members, deletedAt);

  const settings = new Map(local.sharedSettings.map((s) => [s.key, s]));
  const settingUpserts: SharedSetting[] = [];
  for (const r of remote.sharedSettings) {
    const l = settings.get(r.key);
    if (!l || wins(r, l)) {
      settings.set(r.key, r);
      if (!l || l.value !== r.value || l.updated_at !== r.updated_at) settingUpserts.push(r);
    }
  }

  const changed = new Set<string>([...users.upsert.map((u) => u.id), ...users.remove]);
  return {
    users: { upsert: users.upsert, remove: users.remove },
    members: { upsert: members.upsert, remove: members.remove },
    sharedSettings: { upsert: settingUpserts },
    tombstones,
    changedUserIds: [...changed].sort(),
    result: normalizeSnapshot({
      users: users.result,
      members: members.result,
      tombstones,
      sharedSettings: [...settings.values()],
    }),
  };
}

interface Versioned {
  id: string;
  updated_at: string;
}

function wins(candidate: { updated_at: string }, incumbent: { updated_at: string }): boolean {
  if (candidate.updated_at !== incumbent.updated_at) return candidate.updated_at > incumbent.updated_at;
  return stableStringify(candidate) < stableStringify(incumbent);
}

function mergeRecords<T extends Versioned>(
  kind: TombstoneKind,
  local: T[],
  remote: T[],
  deletedAt: Map<string, string>
): { upsert: T[]; remove: string[]; result: T[] } {
  const upsert: T[] = [];
  const remove: string[] = [];
  const result: T[] = [];
  const localById = new Map(local.map((r) => [r.id, r]));
  const remoteById = new Map(remote.map((r) => [r.id, r]));
  const ids = [...new Set([...localById.keys(), ...remoteById.keys()])].sort();

  for (const id of ids) {
    const l = localById.get(id);
    const r = remoteById.get(id);
    let winner: T | undefined;
    if (l && r) winner = wins(r, l) ? r : l;
    else winner = l ?? r;
    if (!winner) continue;

    const tomb = deletedAt.get(`${kind}:${id}`);
    if (tomb && winner.updated_at <= tomb) {
      if (l) remove.push(id);
      continue;
    }

    result.push(winner);
    if (!l || stableStringify(winner) !== stableStringify(l)) upsert.push(winner);
  }
  return { upsert, remove, result };
}
