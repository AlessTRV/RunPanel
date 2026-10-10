import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Who may do what, decided without a database.
 *
 * Every route guard and every stream recheck ends in these functions, so a
 * mistake here is a mistake everywhere at once: too loose and a user reads a
 * project nobody granted them, too strict and a grant silently does nothing.
 * The matrix is small enough to state in full.
 */
export const meta = { name: "authz-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("authz-unit");
  const authz = await import(pathToFileURL(join(repoRoot, "lib", "authz.ts")).href);
  const {
    GLOBAL_PERMISSIONS,
    PROJECT_ACTIONS,
    SERVICE_ACTIONS,
    PRESETS,
    projectAccess,
    serviceAccess,
    folderAccess,
    satisfies,
    hasPermission,
    canEditUser,
    grantableProblem,
    normalizeGrants,
    maxLevel,
    needsHost,
  } = authz;

  const user = (grants = [], permissions = []) => ({
    userId: "u1",
    isOwner: false,
    permissions: new Set(permissions),
    grants,
  });
  const owner = { userId: "o", isOwner: true, permissions: new Set(), grants: [] };
  const g = (scope, scopeId, level, terminal = false) => ({ scope, scopeId, level, terminal });
  const proj = (id, folderId = null) => ({ id, folderId });
  const show = (a) => JSON.stringify(a);

  // --- levels ----------------------------------------------------------------
  r.check("maxLevel picks the higher", maxLevel("read", "manage") === "manage" && maxLevel(null, "read") === "read");
  r.check("maxLevel of nothing is nothing", maxLevel(null, null) === null);

  // --- owner -----------------------------------------------------------------
  {
    const a = projectAccess(owner, proj("p1"));
    r.check("owner manages every project with a terminal", a.level === "manage" && a.terminal === true, show(a));
    r.check("owner has every global permission", GLOBAL_PERMISSIONS.every((p) => hasPermission(owner, p)));
  }

  // --- projects --------------------------------------------------------------
  {
    const a = projectAccess(user(), proj("p1"));
    r.check("no grant means no access", a.level === null && a.terminal === false, show(a));
  }
  {
    const a = projectAccess(user([g("all", null, "read")]), proj("p1"));
    r.check("an all grant reaches any project", a.level === "read", show(a));
  }
  {
    const u = user([g("folder", "f1", "operate")]);
    r.check("a folder grant reaches a project filed there", projectAccess(u, proj("p1", "f1")).level === "operate");
    r.check("a folder grant does not reach a project elsewhere", projectAccess(u, proj("p2", "f2")).level === null);
    r.check("a folder grant does not reach a project at the root", projectAccess(u, proj("p3")).level === null);
  }
  {
    const a = projectAccess(user([g("all", null, "read"), g("project", "p1", "manage")]), proj("p1"));
    r.check("the highest applicable grant wins", a.level === "manage", show(a));
  }
  {
    const a = projectAccess(user([g("project", "p1", "read", true)]), proj("p1"));
    r.check("a terminal flag below operate is ignored", a.terminal === false, show(a));
  }
  {
    const a = projectAccess(user([g("project", "p1", "operate", true)]), proj("p1"));
    r.check("operate with terminal opens a terminal", a.terminal === true && satisfies(a, PROJECT_ACTIONS.terminal));
    r.check("operate cannot reveal env values", !satisfies(a, PROJECT_ACTIONS["env.reveal"]));
    r.check("operate can deploy", satisfies(a, PROJECT_ACTIONS.deploy));
  }
  {
    const a = projectAccess(user([g("project", "p1", "manage")]), proj("p1"));
    r.check("manage without the flag has no terminal", !satisfies(a, PROJECT_ACTIONS.terminal));
    r.check("manage can delete", satisfies(a, PROJECT_ACTIONS.delete));
  }
  {
    const a = projectAccess(user([g("project", "p1", "read")]), proj("p1"));
    r.check("read can view and read logs", satisfies(a, PROJECT_ACTIONS.view) && satisfies(a, PROJECT_ACTIONS.logs));
    r.check("read cannot deploy", !satisfies(a, PROJECT_ACTIONS.deploy));
  }
  r.check("no access satisfies nothing", !satisfies({ level: null, terminal: false }, PROJECT_ACTIONS.view));

  // --- services --------------------------------------------------------------
  {
    const u = user([g("folder", "f1", "read")]);
    const standalone = { id: "s1", folderId: "f1", project: null };
    r.check("a standalone service in a granted folder is visible", serviceAccess(u, standalone).level === "read");
  }
  {
    // A linked service shows under its project: its own folder column is stale
    // by design and must not decide anything.
    const u = user([g("folder", "f1", "read")]);
    const linkedElsewhere = { id: "s1", folderId: "f1", project: proj("p1", "f2") };
    r.check("a linked service ignores its own folder column", serviceAccess(u, linkedElsewhere).level === null);
    const linkedHere = { id: "s2", folderId: null, project: proj("p2", "f1") };
    r.check("a linked service follows its project's folder", serviceAccess(u, linkedHere).level === "read");
  }
  {
    const u = user([g("project", "p1", "operate", true)]);
    const a = serviceAccess(u, { id: "s1", folderId: null, project: proj("p1") });
    r.check("a linked service inherits the project's level and terminal", a.level === "operate" && a.terminal, show(a));
    r.check("console needs the terminal flag", satisfies(a, SERVICE_ACTIONS.console));
  }
  {
    const u = user([g("project", "p1", "read"), g("service", "s1", "manage")]);
    const a = serviceAccess(u, { id: "s1", folderId: null, project: proj("p1") });
    r.check("an explicit service grant can raise above the project", a.level === "manage", show(a));
  }

  // --- folders ---------------------------------------------------------------
  r.check("folderAccess reads folder and all grants", folderAccess(user([g("all", null, "operate")]), "f9").level === "operate");

  // --- global permissions ----------------------------------------------------
  r.check("a held permission is held", hasPermission(user([], ["backup"]), "backup"));
  r.check("an unheld permission is not", !hasPermission(user([], ["backup"]), "restore"));

  // --- editing users ---------------------------------------------------------
  {
    const manager = user([], ["users.manage"]);
    r.check("nobody edits the owner", !canEditUser(manager, { isOwner: true, userId: "o" }));
    r.check("nobody edits themselves", !canEditUser(manager, { isOwner: false, userId: "u1" }));
    r.check("a manager edits another user", canEditUser(manager, { isOwner: false, userId: "u2" }));
    r.check("the owner edits another user", canEditUser(owner, { isOwner: false, userId: "u2" }));
    r.check("without users.manage nobody is editable", !canEditUser(user(), { isOwner: false, userId: "u2" }));

    // Resetting the password of someone with more access is taking their access.
    const narrow = user([g("all", null, "read")], ["users.manage"]);
    const stronger = { isOwner: false, userId: "u2", access: { permissions: ["updates"], grants: [g("all", null, "manage")] } };
    const weaker = { isOwner: false, userId: "u3", access: { permissions: [], grants: [g("project", "p1", "read")] } };
    r.check("a manager cannot touch a stronger account", !canEditUser(narrow, stronger));
    r.check("a manager can touch an account it covers", canEditUser(narrow, weaker));
    r.check("the owner can touch any account", canEditUser(owner, stronger));
  }

  // --- no escalation ---------------------------------------------------------
  {
    const manager = user([g("all", null, "operate")], ["users.manage", "backup"]);
    r.check("granting a held permission is fine", grantableProblem(manager, ["backup"], []) === null);
    r.check("granting an unheld permission is refused", grantableProblem(manager, ["updates"], []) !== null);
    r.check("granting a lower level under all is fine", grantableProblem(manager, [], [g("project", "p1", "read")]) === null);
    r.check("granting a higher level is refused", grantableProblem(manager, [], [g("project", "p1", "manage")]) !== null);
    r.check("granting a terminal one does not have is refused", grantableProblem(manager, [], [g("project", "p1", "operate", true)]) !== null);
  }
  {
    const manager = user([g("project", "p1", "manage", true)], ["users.manage"]);
    r.check("same scope at or below one's own is fine", grantableProblem(manager, [], [g("project", "p1", "operate", true)]) === null);
    r.check("a different scope is refused", grantableProblem(manager, [], [g("project", "p2", "read")]) !== null);
    r.check("an all grant is refused without one", grantableProblem(manager, [], [g("all", null, "read")]) !== null);
  }
  r.check("the owner may grant anything", grantableProblem(owner, [...GLOBAL_PERMISSIONS], [g("all", null, "manage", true)]) === null);

  // --- normalisation ---------------------------------------------------------
  {
    const out = normalizeGrants([g("project", "p1", "read", true), g("project", "p1", "operate"), g("all", "x", "read")]);
    const p1 = out.filter((x) => x.scope === "project" && x.scopeId === "p1");
    r.check("duplicates collapse to the highest", p1.length === 1 && p1[0].level === "operate", show(out));
    r.check("an all grant carries no id", out.find((x) => x.scope === "all")?.scopeId === null, show(out));
    const t = normalizeGrants([g("service", "s1", "read", true)]);
    r.check("terminal is cleared below operate", t[0].terminal === false, show(t));
  }

  // --- what reaches the host -------------------------------------------------
  {
    const docker = { runtimeType: "docker", network: "project", capAdd: [], mounts: [] };
    r.check("a plain container stays in its container", !needsHost(docker));
    r.check("a native runtime runs on the host", needsHost({ ...docker, runtimeType: "node" }));
    r.check("compose can mount the host", needsHost({ ...docker, runtimeType: "compose" }));
    r.check("host networking reaches the host", needsHost({ ...docker, network: "host" }));
    r.check("added capabilities reach the host", needsHost({ ...docker, capAdd: ["SYS_ADMIN"] }));
    r.check("bind mounts reach the host", needsHost({ ...docker, mounts: ["/:/host"] }));
    r.check("host is a known permission", GLOBAL_PERMISSIONS.includes("host"));
  }

  // --- presets ---------------------------------------------------------------
  for (const [name, preset] of Object.entries(PRESETS)) {
    r.check(
      `preset ${name} uses only known permissions`,
      preset.permissions.every((p) => GLOBAL_PERMISSIONS.includes(p)) && preset.grants.length > 0
    );
  }

  return r.result();
}
