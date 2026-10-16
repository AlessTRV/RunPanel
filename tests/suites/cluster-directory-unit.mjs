import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Two panels edit the same accounts; both must end up with the same answer.
 *
 * The merge decides who may log in where. If it does not converge, one panel
 * lets a user in that another has disabled; if a tombstone loses, a deleted
 * account comes back from a stale copy. Both are silent.
 *
 * Standalone: `lib/cluster-directory.ts` has no imports.
 */
export const meta = { name: "cluster-directory-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("cluster-directory-unit");
  const { exportDirectory, mergeDirectory, canonicalDirectory, bumpedUpdatedAt, isSharedSettingKey } = await import(
    pathToFileURL(join(repoRoot, "lib", "cluster-directory.ts")).href
  );

  const t0 = "2026-10-15T10:00:00.000Z";
  const t1 = "2026-10-15T10:01:00.000Z";
  const t2 = "2026-10-15T10:02:00.000Z";
  const user = (id, patch = {}) => ({
    id,
    email: `${id}@x.y`,
    password_hash: "$2b$12$h",
    is_owner: 0,
    disabled: 0,
    created_by: null,
    created_at: t0,
    updated_at: t0,
    permissions: [],
    grants: [],
    ...patch,
  });
  const member = (id, patch = {}) => ({ id, name: id, url: `http://${id}:3000`, role: "panel", created_at: t0, updated_at: t0, ...patch });
  const snap = (patch = {}) => ({ users: [], members: [], tombstones: [], sharedSettings: [], ...patch });

  // --- newer wins, in both directions -----------------------------------------
  {
    const a = snap({ users: [user("u1", { disabled: 1, updated_at: t1 })] });
    const b = snap({ users: [user("u1", { disabled: 0, updated_at: t0 })] });
    const ab = mergeDirectory(a, b);
    const ba = mergeDirectory(b, a);
    r.check("the newer record wins (a already has it)", ab.users.upsert.length === 0 && ab.result.users[0].disabled === 1);
    r.check("the newer record wins (b must adopt it)", ba.users.upsert.length === 1 && ba.result.users[0].disabled === 1);
    r.check("both sides converge", canonicalDirectory(ab.result) === canonicalDirectory(ba.result));
    r.check("the adopting side reports the user as changed", ba.changedUserIds.join() === "u1" && ab.changedUserIds.length === 0);
  }

  // --- an exact tie is broken the same way from either side -------------------
  {
    const a = snap({ users: [user("u1", { email: "zeta@x.y" })] });
    const b = snap({ users: [user("u1", { email: "alpha@x.y" })] });
    const ab = mergeDirectory(a, b).result;
    const ba = mergeDirectory(b, a).result;
    r.check("a tie converges", canonicalDirectory(ab) === canonicalDirectory(ba), `${ab.users[0].email} vs ${ba.users[0].email}`);
  }

  // --- a winning user record replaces permissions and grants wholesale --------
  {
    const g = (id, scope_id) => ({ id, scope: "project", scope_id, level: "read", terminal: 0, created_at: t0 });
    const a = snap({ users: [user("u1", { permissions: ["backup"], grants: [g("g1", "p1")], updated_at: t0 })] });
    const b = snap({ users: [user("u1", { permissions: ["monitor"], grants: [g("g2", "p2")], updated_at: t1 })] });
    const res = mergeDirectory(a, b).result.users[0];
    r.check("permissions are replaced, not unioned", res.permissions.join() === "monitor", res.permissions.join());
    r.check("grants are replaced, not unioned", res.grants.map((x) => x.id).join() === "g2", JSON.stringify(res.grants));
  }

  // --- tombstones ---------------------------------------------------------------
  {
    const stale = snap({ users: [user("u1", { updated_at: t0 })] });
    const deleted = snap({ tombstones: [{ kind: "user", id: "u1", deleted_at: t1 }] });
    const plan = mergeDirectory(stale, deleted);
    r.check("a tombstone removes the stale copy", plan.users.remove.join() === "u1" && plan.result.users.length === 0);
    r.check("the removed user is reported as changed", plan.changedUserIds.join() === "u1");
    r.check("the tombstone is kept", plan.tombstones.length === 1);
    const reverse = mergeDirectory(deleted, stale);
    r.check("the stale copy cannot resurrect the user", reverse.users.upsert.length === 0 && reverse.result.users.length === 0);

    const edited = snap({ users: [user("u1", { updated_at: t2 })] });
    const later = mergeDirectory(deleted, edited);
    r.check("an edit after the deletion survives it", later.result.users.length === 1);

    const m = snap({ members: [member("n1")] });
    const mDel = snap({ tombstones: [{ kind: "member", id: "n1", deleted_at: t1 }] });
    r.check("member tombstones work the same way", mergeDirectory(m, mDel).members.remove.join() === "n1");
    r.check("a user tombstone does not touch a member with the same id", mergeDirectory(snap({ members: [member("u1")] }), deleted).members.remove.length === 0);
  }

  // --- members and shared settings ----------------------------------------------
  {
    const a = snap({ members: [member("n1", { role: "node", updated_at: t1 })], sharedSettings: [{ key: "github_token", value: "old", updated_at: t0 }] });
    const b = snap({ members: [member("n1", { role: "panel", updated_at: t0 }), member("n2")], sharedSettings: [{ key: "github_token", value: "new", updated_at: t1 }] });
    const plan = mergeDirectory(a, b);
    r.check("a's newer member row wins, b's new member is adopted", plan.members.upsert.map((m) => m.id).join() === "n2" && plan.result.members.find((m) => m.id === "n1").role === "node");
    r.check("the newer shared setting wins", plan.sharedSettings.upsert.length === 1 && plan.sharedSettings.upsert[0].value === "new");
    r.check("an identical snapshot yields an empty plan", (() => {
      const p = mergeDirectory(plan.result, plan.result);
      return p.users.upsert.length === 0 && p.members.upsert.length === 0 && p.sharedSettings.upsert.length === 0 && p.users.remove.length === 0;
    })());
  }

  // --- canonical form -----------------------------------------------------------
  {
    const x = snap({ users: [user("u2"), user("u1", { permissions: ["b", "a", "a"] })], members: [member("n2"), member("n1")] });
    const y = snap({ users: [user("u1", { permissions: ["a", "b"] }), user("u2")], members: [member("n1"), member("n2")] });
    r.check("order and duplicates do not change the canonical form", canonicalDirectory(x) === canonicalDirectory(y));
    r.check("content does", canonicalDirectory(x) !== canonicalDirectory(snap({ users: [user("u1")] })));
  }

  // --- exportDirectory groups flat rows -----------------------------------------
  {
    const out = exportDirectory({
      users: [{ id: "u1", email: null, password_hash: null, is_owner: 1, disabled: 0, created_by: null, created_at: t0, updated_at: null }],
      permissions: [{ user_id: "u1", permission: "backup" }, { user_id: "ghost", permission: "x" }],
      grants: [{ id: "g1", user_id: "u1", scope: "all", scope_id: "", level: "manage", terminal: 1, created_at: t0 }],
      members: [],
      tombstones: [],
      sharedSettings: [],
    });
    r.check("a null updated_at reads as created_at", out.users[0].updated_at === t0);
    r.check("permissions and grants are attached to their user", out.users[0].permissions.join() === "backup" && out.users[0].grants[0].id === "g1");
  }

  // --- bumpedUpdatedAt ----------------------------------------------------------
  {
    r.check("a later clock just uses now", bumpedUpdatedAt(t0, t1) === t1);
    r.check("a clock that is behind still moves forward", bumpedUpdatedAt(t1, t0) > t1, bumpedUpdatedAt(t1, t0));
    r.check("the same instant moves forward too", bumpedUpdatedAt(t1, t1) > t1);
    r.check("no previous value uses now", bumpedUpdatedAt(null, t0) === t0);
  }

  r.check("shared setting keys are the three agreed ones", isSharedSettingKey("github_token") && isSharedSettingKey("telegram_chat_id") && !isSharedSettingKey("panel_public_url"));

  return r.result();
}
