/**
 * Who may do what — the decision, with no database and no Node imports.
 *
 * Every guard in `lib/auth-guard.ts` and every stream recheck ends here, so the
 * rules live in one place a test can load directly (`tests/suites/authz-unit`).
 * The data that feeds it is loaded by `lib/principal.ts`.
 *
 * The model:
 * - the owner can do everything, always;
 * - everyone else holds a set of global permissions and a list of grants;
 * - a grant points at everything, a folder, a project or a service, and carries
 *   a level plus a terminal flag;
 * - the effective level is the highest applicable grant. There are no deny
 *   rules: removing access means removing the grant.
 */

export type Level = "read" | "operate" | "manage";
export type GrantScope = "all" | "folder" | "project" | "service";

export const GLOBAL_PERMISSIONS = [
  "projects.create",
  "github",
  "registries",
  "monitor",
  "storage",
  "backup",
  "restore",
  "autostart",
  "diagnostics",
  "notifications",
  "updates",
  "users.manage",
  "audit.view",
  "host",
  "nodes",
] as const;
export type GlobalPermission = (typeof GLOBAL_PERMISSIONS)[number];

export const LEVELS: readonly Level[] = ["read", "operate", "manage"];
export const GRANT_SCOPES: readonly GrantScope[] = ["all", "folder", "project", "service"];

export interface Grant {
  scope: GrantScope;
  /** Null for `all`, the target's id otherwise. */
  scopeId: string | null;
  level: Level;
  /** Only meaningful from `operate` up; see `normalizeGrants`. */
  terminal: boolean;
}

export interface Principal {
  userId: string;
  isOwner: boolean;
  permissions: ReadonlySet<GlobalPermission>;
  grants: readonly Grant[];
}

export interface Access {
  level: Level | null;
  terminal: boolean;
}

export interface ProjectRef {
  id: string;
  folderId: string | null;
}

/**
 * A linked service shows under its project, so its own `folder_id` is ignored
 * then — the route that links one clears it, but a stale value must not decide.
 */
export interface ServiceRef {
  id: string;
  folderId: string | null;
  project: ProjectRef | null;
}

export interface Requirement {
  level: Level;
  terminal?: boolean;
}

export const PROJECT_ACTIONS = {
  view: { level: "read" },
  logs: { level: "read" },
  "env.read": { level: "read" },
  deploy: { level: "operate" },
  control: { level: "operate" },
  "env.reveal": { level: "manage" },
  "env.write": { level: "manage" },
  settings: { level: "manage" },
  files: { level: "manage" },
  mounts: { level: "manage" },
  "one-time": { level: "manage" },
  webhook: { level: "manage" },
  backup: { level: "manage" },
  delete: { level: "manage" },
  terminal: { level: "operate", terminal: true },
} as const satisfies Record<string, Requirement>;
export type ProjectAction = keyof typeof PROJECT_ACTIONS;

export const SERVICE_ACTIONS = {
  view: { level: "read" },
  control: { level: "operate" },
  credentials: { level: "manage" },
  databases: { level: "manage" },
  mounts: { level: "manage" },
  settings: { level: "manage" },
  delete: { level: "manage" },
  console: { level: "operate", terminal: true },
} as const satisfies Record<string, Requirement>;
export type ServiceAction = keyof typeof SERVICE_ACTIONS;

const NO_ACCESS: Access = { level: null, terminal: false };
const FULL_ACCESS: Access = { level: "manage", terminal: true };

export function levelRank(level: Level | null): number {
  return level === null ? 0 : LEVELS.indexOf(level) + 1;
}

export function maxLevel(a: Level | null, b: Level | null): Level | null {
  return levelRank(a) >= levelRank(b) ? a : b;
}

function combine(a: Access, b: Access): Access {
  return { level: maxLevel(a.level, b.level), terminal: a.terminal || b.terminal };
}

function grantAccess(grant: Grant): Access {
  return { level: grant.level, terminal: grant.terminal && levelRank(grant.level) >= levelRank("operate") };
}

/** Access from the grants matching any of the given targets. */
function accessFor(principal: Principal, targets: ReadonlyArray<[GrantScope, string | null]>): Access {
  if (principal.isOwner) return FULL_ACCESS;
  let access = NO_ACCESS;
  for (const grant of principal.grants) {
    const matches = targets.some(
      ([scope, id]) => grant.scope === scope && (scope === "all" || (id !== null && grant.scopeId === id))
    );
    if (matches) access = combine(access, grantAccess(grant));
  }
  return access;
}

export function folderAccess(principal: Principal, folderId: string): Access {
  return accessFor(principal, [["all", null], ["folder", folderId]]);
}

export function projectAccess(principal: Principal, ref: ProjectRef): Access {
  return accessFor(principal, [["all", null], ["folder", ref.folderId], ["project", ref.id]]);
}

export function serviceAccess(principal: Principal, ref: ServiceRef): Access {
  const own = accessFor(principal, [
    ["all", null],
    ["service", ref.id],
    ["folder", ref.project ? null : ref.folderId],
  ]);
  return ref.project ? combine(own, projectAccess(principal, ref.project)) : own;
}

export function satisfies(access: Access, requirement: Requirement): boolean {
  if (levelRank(access.level) < levelRank(requirement.level)) return false;
  return !requirement.terminal || access.terminal;
}

export function hasPermission(principal: Principal, permission: GlobalPermission): boolean {
  return principal.isOwner || principal.permissions.has(permission);
}

/**
 * The owner is out of reach, nobody edits their own access, and a manager only
 * touches accounts whose access they could have granted themselves. Without
 * that last rule, resetting the password of a more powerful account would be a
 * way to become it.
 */
export function canEditUser(
  manager: Principal,
  target: {
    isOwner: boolean;
    userId: string;
    access?: { permissions: readonly GlobalPermission[]; grants: readonly Grant[] };
  }
): boolean {
  if (target.isOwner || target.userId === manager.userId) return false;
  if (!hasPermission(manager, "users.manage")) return false;
  return !target.access || grantableProblem(manager, target.access.permissions, target.access.grants) === null;
}

/**
 * Why `manager` may not hand out this access, or null when they may.
 *
 * A manager can only give what they hold: each permission must be theirs, and
 * each grant must be covered by one of theirs — on the same target, or by an
 * `all` grant — at an equal or higher level, terminal included. Without this,
 * `users.manage` would be a way to promote oneself through a second account.
 */
export function grantableProblem(
  manager: Principal,
  permissions: readonly GlobalPermission[],
  grants: readonly Grant[]
): string | null {
  if (manager.isOwner) return null;

  for (const permission of permissions) {
    if (!manager.permissions.has(permission)) return `Non puoi concedere il permesso "${permission}"`;
  }

  for (const grant of normalizeGrants(grants)) {
    const covered = manager.grants.some((own) => {
      const sameTarget = own.scope === "all" || (own.scope === grant.scope && own.scopeId === grant.scopeId);
      if (!sameTarget) return false;
      if (levelRank(own.level) < levelRank(grant.level)) return false;
      return !grant.terminal || grantAccess(own).terminal;
    });
    if (!covered) return "Non puoi concedere un accesso più ampio del tuo";
  }
  return null;
}

/**
 * One grant per target, the highest kept; `all` carries no id; the terminal
 * flag is dropped below `operate`, where it would mean nothing.
 */
export function normalizeGrants(grants: readonly Grant[]): Grant[] {
  const byTarget = new Map<string, Grant>();
  for (const raw of grants) {
    const scopeId = raw.scope === "all" ? null : raw.scopeId;
    const grant: Grant = {
      scope: raw.scope,
      scopeId,
      level: raw.level,
      terminal: raw.terminal && levelRank(raw.level) >= levelRank("operate"),
    };
    const key = `${grant.scope}:${scopeId ?? ""}`;
    const prev = byTarget.get(key);
    byTarget.set(
      key,
      prev
        ? { ...grant, level: maxLevel(prev.level, grant.level) ?? grant.level, terminal: prev.terminal || grant.terminal }
        : grant
    );
  }
  return [...byTarget.values()];
}

/**
 * Whether a project, configured this way, can reach the host it runs on.
 *
 * Only a plain container is contained. A native runtime runs its build and
 * start commands as the panel's own user, which reads the panel's store and
 * secret key; Compose files come from the repository and can mount anything;
 * host networking, added capabilities and bind mounts all reach past the
 * container. Configuring any of these is reserved to the owner and to whoever
 * holds the `host` permission — otherwise `manage` on one project would be a
 * way to own the panel.
 */
export function needsHost(config: {
  runtimeType: string;
  network?: string;
  capAdd?: readonly string[];
  mounts?: readonly string[];
}): boolean {
  if (config.runtimeType !== "docker") return true;
  return config.network === "host" || (config.capAdd?.length ?? 0) > 0 || (config.mounts?.length ?? 0) > 0;
}

/** Starting points for the user page; applied once, then freely edited. */
export const PRESETS: Record<"viewer" | "developer" | "sysop", { permissions: GlobalPermission[]; grants: Grant[] }> = {
  viewer: {
    permissions: [],
    grants: [{ scope: "all", scopeId: null, level: "read", terminal: false }],
  },
  developer: {
    permissions: ["projects.create", "github"],
    grants: [{ scope: "all", scopeId: null, level: "operate", terminal: false }],
  },
  sysop: {
    permissions: ["monitor", "storage", "backup", "autostart", "diagnostics"],
    grants: [{ scope: "all", scopeId: null, level: "operate", terminal: false }],
  },
};
