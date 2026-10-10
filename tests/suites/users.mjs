import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * Several accounts on one panel, end to end through the API.
 *
 * The unit suites prove the decision; this proves the routes ask for it: an
 * invited account starts with nothing, sees exactly what it is granted, cannot
 * act above its level, cannot hand out more than its manager holds, and stops
 * working the moment it is disabled. No Docker: projects here are empty rows.
 */
export const meta = { name: "users", needsDocker: false, drivers: ["sqlite", "postgres"] };

const OWNER = { email: "owner@runpanel.test", password: "users-owner-pw" };

export async function run({ base }) {
  const r = createReporter("users");
  const owner = client(base);
  const json = (method, body) => ({ method, body: JSON.stringify(body) });

  let res = await owner.call("/api/auth/login", json("POST", { setup: true, setupToken: SETUP_TOKEN, ...OWNER }));
  r.check("setup creates the owner", res.status === 200, JSON.stringify(res.body));

  res = await owner.call("/api/auth/me");
  r.check("the owner is the owner", res.body?.user?.isOwner === true && res.body?.emailRequired === false, JSON.stringify(res.body));

  // --- invitation ------------------------------------------------------------
  res = await owner.call("/api/users", json("POST", { email: "Dev@Example.test", hours: 1 }));
  r.check("an invitation is created", res.status === 201 && typeof res.body?.invitePath === "string", JSON.stringify(res.body));
  const devId = res.body?.user?.id;
  const firstToken = res.body?.invitePath?.split("/").pop();

  res = await owner.call("/api/users", json("POST", { email: "dev@example.test", hours: 1 }));
  r.check("the same email twice is refused", res.status === 409, String(res.status));

  res = await owner.call("/api/users", json("POST", { email: "x@example.test", hours: 24 * 31 }));
  r.check("a link longer than 30 days is refused", res.status === 400, String(res.status));

  // A fresh link voids the previous one.
  res = await owner.call(`/api/users/${devId}/invite`, json("POST", { hours: 2 }));
  r.check("a new link is issued", res.status === 200 && res.body?.kind === "invite", JSON.stringify(res.body));
  const token = res.body?.invitePath?.split("/").pop();

  const dev = client(base);
  res = await dev.call(`/api/auth/invite?token=${firstToken}`);
  r.check("the voided link is refused", res.status === 400, String(res.status));

  res = await dev.call(`/api/auth/invite?token=${token}`);
  r.check("the link names its email", res.status === 200 && res.body?.email === "dev@example.test", JSON.stringify(res.body));

  res = await dev.call("/api/auth/invite", json("POST", { token, password: "dev-password-1" }));
  r.check("the invitation is accepted", res.status === 200, JSON.stringify(res.body));

  res = await client(base).call("/api/auth/invite", json("POST", { token, password: "someone-else-1" }));
  r.check("a used link is refused", res.status === 400, String(res.status));

  // --- nothing until granted -------------------------------------------------
  res = await owner.call("/api/projects", json("POST", { name: "Secret Project" }));
  const projectId = res.body?.id;
  r.check("the owner creates a project", res.status === 201 && Boolean(projectId), JSON.stringify(res.body));

  res = await dev.call("/api/projects");
  r.check("a new account lists no projects", res.status === 200 && Array.isArray(res.body) && res.body.length === 0, JSON.stringify(res.body));
  res = await dev.call(`/api/projects/${projectId}`);
  r.check("an ungranted project is not found", res.status === 404, String(res.status));
  res = await dev.call("/api/monitor");
  r.check("a panel permission it lacks is forbidden", res.status === 403, String(res.status));
  res = await dev.call("/api/users");
  r.check("it cannot list users", res.status === 403, String(res.status));

  // --- read grant ------------------------------------------------------------
  res = await owner.call(
    `/api/users/${devId}`,
    json("PATCH", { access: { permissions: [], grants: [{ scope: "project", scopeId: projectId, level: "read", terminal: false }] } })
  );
  r.check("the owner grants read", res.status === 200, JSON.stringify(res.body));

  res = await dev.call("/api/projects");
  r.check("the granted project is listed", res.status === 200 && res.body?.length === 1 && res.body[0].id === projectId, JSON.stringify(res.body));
  res = await dev.call(`/api/projects/${projectId}`);
  r.check("the granted project opens", res.status === 200, String(res.status));
  res = await dev.call(`/api/projects/${projectId}/deploy`, json("POST", {}));
  r.check("read cannot deploy", res.status === 403, String(res.status));
  res = await dev.call(`/api/projects/${projectId}`, json("PATCH", { name: "Renamed" }));
  r.check("read cannot change settings", res.status === 403, String(res.status));
  res = await dev.call(`/api/projects/${projectId}/terminal`, json("POST", { command: "id" }));
  r.check("read has no terminal", res.status === 403, String(res.status));

  // --- an open stream ends when access is taken away -------------------------
  {
    const ctrl = new AbortController();
    const stream = await fetch(`${base}/api/projects/${projectId}/stream`, { headers: { cookie: dev.cookie }, signal: ctrl.signal });
    r.check("a read account can open the project stream", stream.status === 200, String(stream.status));
    const reader = stream.body.getReader();
    const first = await reader.read();
    r.check("the stream says ready", !first.done && new TextDecoder().decode(first.value).includes('"ready"'));

    await owner.call(`/api/users/${devId}`, json("PATCH", { access: { permissions: [], grants: [] } }));

    const ended = await Promise.race([
      (async () => {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return true;
        }
      })().catch(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    ctrl.abort();
    r.check("revoking the grant closes the open stream", ended === true);
  }

  // --- no escalation through users.manage ------------------------------------
  res = await owner.call("/api/users", json("POST", { email: "manager@example.test", hours: 1 }));
  const managerId = res.body?.user?.id;
  const managerToken = res.body?.invitePath?.split("/").pop();
  await owner.call(
    `/api/users/${managerId}`,
    json("PATCH", { access: { permissions: ["users.manage", "backup"], grants: [{ scope: "all", scopeId: null, level: "operate", terminal: false }] } })
  );
  const manager = client(base);
  await manager.call("/api/auth/invite", json("POST", { token: managerToken, password: "manager-pw-1" }));

  res = await manager.call(`/api/users/${devId}`, json("PATCH", { access: { permissions: ["updates"], grants: [] } }));
  r.check("a manager cannot grant what it lacks", res.status === 403, String(res.status));
  res = await manager.call(
    `/api/users/${devId}`,
    json("PATCH", { access: { permissions: [], grants: [{ scope: "all", scopeId: null, level: "manage", terminal: false }] } })
  );
  r.check("a manager cannot grant above its level", res.status === 403, String(res.status));
  res = await manager.call(
    `/api/users/${devId}`,
    json("PATCH", { access: { permissions: ["backup"], grants: [{ scope: "project", scopeId: projectId, level: "operate", terminal: false }] } })
  );
  r.check("a manager grants within its reach", res.status === 200, JSON.stringify(res.body));
  res = await manager.call(`/api/users/${managerId}`, json("PATCH", { disabled: true }));
  r.check("a manager cannot edit itself", res.status === 403, String(res.status));

  const ownerId = (await owner.call("/api/auth/me")).body?.user?.id;
  res = await manager.call(`/api/users/${ownerId}`, json("PATCH", { disabled: true }));
  r.check("nobody edits the owner", res.status === 403, String(res.status));
  res = await manager.call(`/api/users/${ownerId}/invite`, json("POST", { hours: 1 }));
  r.check("nobody resets the owner", res.status === 403, String(res.status));

  // --- logins ----------------------------------------------------------------
  res = await client(base).call("/api/auth/login", json("POST", { email: "", password: "dev-password-1" }));
  r.check("an empty email does not find an invited account", res.status === 401, String(res.status));
  res = await client(base).call("/api/auth/login", json("POST", { email: "nobody@example.test", password: "whatever-1" }));
  r.check("an unknown email reads like a wrong password", res.status === 401 && res.body?.error === "Credenziali non valide", JSON.stringify(res.body));

  // --- secrets and the host --------------------------------------------------
  res = await manager.call(`/api/projects/${projectId}`);
  r.check("below manage the webhook secret is blank", res.status === 200 && res.body?.webhook_secret === "", JSON.stringify(res.body?.webhook_secret));
  r.check("the project says what the account may do", res.body?.permission?.level === "operate", JSON.stringify(res.body?.permission));

  await owner.call(
    `/api/users/${devId}`,
    json("PATCH", { access: { permissions: [], grants: [{ scope: "all", scopeId: null, level: "manage", terminal: false }] } })
  );
  res = await dev.call(`/api/projects/${projectId}/env`, json("PUT", { vars: [{ key: "NODE_OPTIONS", value: "--import x" }] }));
  r.check("manage without host cannot set variables of a native project", res.status === 403 && res.body?.code === "host_required", JSON.stringify(res.body));
  res = await dev.call(`/api/projects/${projectId}`, json("PATCH", { sourceUrl: "https://github.com/x/y" }));
  r.check("manage without host cannot change the code source", res.status === 403, String(res.status));
  res = await dev.call(`/api/projects/${projectId}/mounts`, json("PUT", { mounts: [] }));
  r.check("manage without host cannot mount host folders", res.status === 403 && res.body?.code === "host_required", JSON.stringify(res.body));

  // --- a manager cannot take over a stronger account -------------------------
  res = await manager.call(`/api/users/${devId}/invite`, json("POST", { hours: 1 }));
  r.check("a manager cannot reset a stronger account", res.status === 403, String(res.status));

  // --- activity log ----------------------------------------------------------
  res = await owner.call("/api/audit?limit=200");
  const actions = new Set((res.body?.entries ?? []).map((e) => e.action));
  r.check("the log records invitations and sign-ins", res.status === 200 && actions.has("user.invite") && actions.has("auth.login.failed") && actions.has("user.access"), JSON.stringify([...actions]));
  r.check("a refused deploy is not recorded as one", !actions.has("project.deploy"));
  res = await dev.call("/api/audit");
  r.check("reading the log needs its permission", res.status === 403, String(res.status));
  res = await manager.call("/api/audit/settings", json("PUT", { categories: [] }));
  r.check("only the owner chooses what is recorded", res.status === 403, String(res.status));
  res = await owner.call("/api/audit/settings", json("PUT", { categories: ["deploy"], retentionDays: 30 }));
  r.check("the owner narrows the log", res.status === 200, JSON.stringify(res.body));
  res = await owner.call("/api/audit/settings");
  r.check("security stays on", res.body?.categories?.includes("security") && res.body?.retentionDays === 30, JSON.stringify(res.body));

  // --- disabling -------------------------------------------------------------
  res = await owner.call(`/api/users/${devId}`, json("PATCH", { disabled: true }));
  r.check("the owner disables an account", res.status === 200, String(res.status));
  res = await dev.call("/api/projects");
  r.check("a disabled account is signed out", res.status === 401, String(res.status));
  res = await client(base).call("/api/auth/login", json("POST", { email: "dev@example.test", password: "dev-password-1" }));
  r.check("a disabled account cannot sign in", res.status === 401, String(res.status));

  // --- deleting a project removes its grants ---------------------------------
  await owner.call(
    `/api/users/${devId}`,
    json("PATCH", { access: { permissions: [], grants: [{ scope: "project", scopeId: projectId, level: "read", terminal: false }] } })
  );
  res = await owner.call(`/api/projects/${projectId}`, { method: "DELETE" });
  r.check("the project is deleted", res.status === 200, JSON.stringify(res.body));
  res = await owner.call(`/api/users/${devId}`);
  r.check(
    "its grants went with it",
    res.status === 200 && !res.body?.access?.grants?.some((g) => g.scopeId === projectId),
    JSON.stringify(res.body?.access)
  );

  return r.result();
}
