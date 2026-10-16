import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { client, createReporter, startServer, SETUP_TOKEN } from "../harness.mjs";

/**
 * Two RunPanel installs becoming one cluster.
 *
 * Server A is the suite's own; server B is started here and linked from its
 * first-run page. Then everything the feature promises, end to end: the same
 * account signs in on both, A manages B's projects through the proxy
 * (including the live stream), accounts and the GitHub token edited on either
 * side show up on the other, a diagnosis agrees with itself, a role change
 * takes B's own sign-in away, a secret rotation keeps them talking, and a
 * revocation leaves B on its own.
 *
 * No Docker: nothing is deployed, only created and listed. The schedulers are
 * off in the harness, so each sync is driven with `POST /api/cluster/sync`.
 */
export const meta = { name: "cluster", needsDocker: false, drivers: ["sqlite"] };

const PASSWORD = "cluster-suite-pw";
const OWNER = "owner@cluster.test";

export async function run({ base, repoRoot }) {
  const r = createReporter("cluster");
  const { signedHeaders, EMPTY_BODY_SHA256 } = await import(pathToFileURL(join(repoRoot, "lib", "cluster-sign.ts")).href);

  const a = client(base);
  let res = await a.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, email: OWNER, setupToken: SETUP_TOKEN, password: PASSWORD }),
  });
  r.check("A is set up", res.status === 200, JSON.stringify(res.body));

  res = await a.call("/api/cluster");
  r.check("before any link, A is solo", res.body.solo === true && res.body.members.length === 0, JSON.stringify(res.body));

  // --- the link token --------------------------------------------------------
  res = await a.call("/api/cluster/link-tokens", { method: "POST", body: JSON.stringify({ name: "pannello-a" }) });
  r.check("A hands out a link token", res.status === 200 && typeof res.body.token === "string" && res.body.panelUrl === base, JSON.stringify(res.body));
  const token = res.body.token;

  res = await a.call("/api/cluster");
  r.check("issuing a token created the cluster with A in it", res.body.solo === false && res.body.members.length === 1 && res.body.members[0].self === true, JSON.stringify(res.body));

  const serverB = await startServer();
  const b = client(serverB.base);
  try {
    res = await b.call("/api/auth/check");
    r.check("B starts on its first run", res.body.firstRun === true, JSON.stringify(res.body));

    // --- joining from the setup page --------------------------------------------
    res = await b.call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        setup: true,
        setupToken: SETUP_TOKEN,
        link: { panelUrl: base, token: "not-the-token-at-all", name: "nodo-b", url: serverB.base, role: "panel" },
      }),
    });
    r.check("a wrong link token is refused", res.status === 403, `${res.status} ${JSON.stringify(res.body)}`);

    res = await b.call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        setup: true,
        setupToken: "wrong-setup-token",
        link: { panelUrl: base, token, name: "nodo-b", url: serverB.base, role: "panel" },
      }),
    });
    r.check("the setup token is still required", res.status === 403, `${res.status}`);

    res = await b.call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        setup: true,
        setupToken: SETUP_TOKEN,
        link: { panelUrl: base, token, name: "nodo-b", url: serverB.base, role: "panel" },
      }),
    });
    r.check("B joins A's cluster", res.status === 200 && res.body.linked === true, `${res.status} ${JSON.stringify(res.body)}`);

    res = await b.call("/api/auth/check");
    r.check("B is no longer on its first run", res.body.firstRun === false && res.body.role === "panel", JSON.stringify(res.body));

    res = await b.call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, link: { panelUrl: base, token, name: "x", url: serverB.base, role: "panel" } }),
    });
    r.check("a spent token cannot be used again", res.status === 403 || res.status === 409, `${res.status}`);

    res = await a.call("/api/cluster");
    const memberB = res.body.members.find((m) => m.name === "nodo-b");
    r.check("A lists B as a member", Boolean(memberB) && memberB.role === "panel" && memberB.url === serverB.base, JSON.stringify(res.body));

    // --- one account, two panels -------------------------------------------------
    res = await b.call("/api/auth/login", { method: "POST", body: JSON.stringify({ email: OWNER, password: PASSWORD }) });
    r.check("the owner signs in on B with the same password", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);

    res = await b.call("/api/cluster");
    r.check("B sees both members, itself marked", res.body.members.length === 2 && res.body.members.some((m) => m.self && m.name === "nodo-b"), JSON.stringify(res.body));

    // --- what a stranger gets ------------------------------------------------------
    const bare = await fetch(`${serverB.base}/api/cluster/ping`);
    r.check("an unsigned ping is refused", bare.status === 401, String(bare.status));

    const forged = signedHeaders("f".repeat(64), {
      method: "GET",
      path: "/api/cluster/ping",
      query: "",
      memberId: memberB.id,
      userId: null,
      bodySha256: EMPTY_BODY_SHA256,
    });
    const wrong = await fetch(`${serverB.base}/api/cluster/ping`, { headers: forged });
    r.check("a ping signed with another secret is refused", wrong.status === 401, String(wrong.status));

    const noCookie = await fetch(`${serverB.base}/api/projects`);
    r.check("B still refuses a cookie-less request", noCookie.status === 401, String(noCookie.status));

    // A captured request must not work twice. The suite joins as a third
    // member of its own, with the real secret, so it can sign requests.
    res = await a.call("/api/cluster/link-tokens", { method: "POST", body: JSON.stringify({}) });
    const spyJoin = await fetch(`${base}/api/cluster/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: res.body.token, name: "spia", url: "http://127.0.0.1:9", role: "node" }),
    });
    const spy = await spyJoin.json();
    r.check("a third member joins directly", spyJoin.status === 200 && /^[0-9a-f]{64}$/.test(spy.secret), String(spyJoin.status));

    // That member's address answers nothing: an aggregated list must still come
    // back, with the member reported as unreachable.
    res = await a.call("/api/cluster/projects");
    const spyStatus = res.body.members?.find((m) => m.id === spy.memberId);
    r.check("an unreachable member gives a partial result, not an error", res.status === 200 && spyStatus && spyStatus.ok === false && spyStatus.reachable === false, JSON.stringify(res.body.members));
    r.check("the other servers still answer", res.body.members?.filter((m) => m.id !== spy.memberId).every((m) => m.ok), JSON.stringify(res.body.members));
    const signedPing = signedHeaders(spy.secret, { method: "GET", path: "/api/cluster/ping", query: "", memberId: spy.memberId, userId: null, bodySha256: EMPTY_BODY_SHA256 });
    const first = await fetch(`${base}/api/cluster/ping`, { headers: signedPing });
    const again = await fetch(`${base}/api/cluster/ping`, { headers: signedPing });
    r.check("a signed request is accepted once", first.status === 200, String(first.status));
    r.check("the same request sent again is a replay", again.status === 401, String(again.status));
    const ownerId = (await a.call("/api/auth/me")).body.user.id;
    const repointed = await fetch(`${base}/api/auth/me`, { headers: { ...signedPing, "x-runpanel-user": ownerId } });
    r.check("a signature cannot be re-pointed at another route", repointed.status === 401, String(repointed.status));
    res = await a.call(`/api/cluster/members/${spy.memberId}`, { method: "DELETE" });
    r.check("the third member is revoked again", res.status === 200, String(res.status));

    // --- the proxy -------------------------------------------------------------------
    res = await a.call(`/api/nodes/${memberB.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Demo su B" }) });
    r.check("A creates a project on B through the proxy", res.status === 201 && typeof res.body.id === "string", `${res.status} ${JSON.stringify(res.body)}`);
    const projectId = res.body.id;

    res = await b.call("/api/projects");
    r.check("the project really lives on B", Array.isArray(res.body) && res.body.some((p) => p.id === projectId), JSON.stringify(res.body));
    res = await a.call("/api/projects");
    r.check("and not on A", Array.isArray(res.body) && !res.body.some((p) => p.id === projectId));

    res = await a.call(`/api/nodes/${memberB.id}/projects/${projectId}`);
    r.check("A reads it back through the proxy", res.status === 200 && res.body.name === "Demo su B", `${res.status}`);

    res = await a.call(`/api/nodes/${memberB.id}/projects/${projectId}?x=1`, { method: "PATCH", body: JSON.stringify({ name: "Rinominato" }) });
    r.check("a PATCH with a query string goes through", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);

    res = await a.call(`/api/nodes/${memberB.id}/projects/does-not-exist`);
    r.check("B's 404 comes back as a 404", res.status === 404, `${res.status}`);

    res = await a.call(`/api/nodes/no-such-member/projects`);
    r.check("an unknown member is a 404", res.status === 404, `${res.status}`);

    res = await a.call("/api/cluster");
    const selfA = res.body.members.find((m) => m.self);
    res = await a.call(`/api/nodes/${selfA.id}/projects`);
    r.check("forwarding to oneself is refused", res.status === 400, `${res.status}`);

    // The live stream: the first frame says `ready`, which means the SSE route
    // on B answered and its body is flowing back through A unbuffered.
    const stream = await fetch(`${base}/api/nodes/${memberB.id}/projects/${projectId}/stream`, {
      headers: { cookie: a.cookie, accept: "text/event-stream" },
    });
    let firstFrame = "";
    if (stream.ok && stream.body) {
      const reader = stream.body.getReader();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !firstFrame.includes("\n\n")) {
        const next = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve({ done: true }), deadline - Date.now()))]);
        if (next.done) break;
        firstFrame += Buffer.from(next.value).toString("utf8");
      }
      await reader.cancel().catch(() => undefined);
    }
    r.check("the SSE stream is relayed", stream.status === 200 && firstFrame.includes('"type":"ready"'), `${stream.status} ${firstFrame.slice(0, 120)}`);

    // --- aggregated views ------------------------------------------------------------
    res = await a.call("/api/cluster/servers");
    const cardB = res.body.servers?.find((s) => s.memberId === memberB.id);
    r.check("the servers overview lists both servers", res.body.servers?.length === 2 && res.body.servers.every((s) => s.reachable), JSON.stringify(res.body).slice(0, 300));
    r.check("each card carries a summary with metrics for the owner", Boolean(cardB?.summary?.metrics) && cardB.summary.projects.total === 1, JSON.stringify(cardB?.summary));

    res = await a.call("/api/server-summary");
    r.check("server-summary answers locally", res.status === 200 && typeof res.body.version === "string", JSON.stringify(res.body).slice(0, 200));

    res = await a.call("/api/cluster/projects");
    const aggregated = res.body.items ?? [];
    r.check("aggregated projects include B's project, tagged with B", aggregated.some((p) => p.id === projectId && p.memberId === memberB.id && p.memberName === "nodo-b"), JSON.stringify(aggregated).slice(0, 300));
    r.check("and report how each server answered", res.body.members?.length === 2 && res.body.members.every((m) => m.ok), JSON.stringify(res.body.members));

    res = await a.call("/api/cluster/services");
    r.check("aggregated services answer", res.status === 200 && Array.isArray(res.body.items), String(res.status));
    res = await a.call("/api/cluster/folders");
    r.check("aggregated folders answer", res.status === 200 && Array.isArray(res.body.items), String(res.status));

    res = await a.call("/api/cluster/backups");
    r.check("aggregated backups carry each server's destinations", res.status === 200 && res.body.destinations?.some((d) => d.memberId === memberB.id) && res.body.perServer?.length === 2, JSON.stringify(res.body).slice(0, 300));

    res = await a.call("/api/cluster/monitor");
    const monB = res.body.servers?.find((s) => s.memberId === memberB.id);
    r.check("the monitor has one entry per server", res.body.servers?.length === 2 && monB?.data?.projects?.some((p) => p.id === projectId), JSON.stringify(res.body).slice(0, 300));

    res = await a.call("/api/cluster/diagnostics");
    r.check("diagnostics of every server", res.body.servers?.length === 2 && res.body.servers.every((s) => Array.isArray(s.data?.checks)), JSON.stringify(res.body).slice(0, 200));

    res = await a.call("/api/cluster/updates");
    r.check("updates of every server", res.body.servers?.length === 2 && res.body.servers.every((s) => s.data?.release?.label), JSON.stringify(res.body).slice(0, 200));

    res = await a.call(`/api/cluster/locate?kind=project&id=${projectId}`);
    r.check("locate finds the project on B", res.body.memberId === memberB.id, JSON.stringify(res.body));
    res = await a.call("/api/cluster/locate?kind=project&id=nope");
    r.check("locate finds nothing for an unknown id", res.status === 200 && res.body.memberId === null, JSON.stringify(res.body));
    res = await a.call("/api/cluster/locate?kind=folder&id=x");
    r.check("locate refuses an unknown kind", res.status === 400, String(res.status));

    // Two identical aggregated calls at once must not trip the replay guard.
    const [twin1, twin2] = await Promise.all([a.call("/api/cluster/projects"), a.call("/api/cluster/projects")]);
    r.check("parallel aggregated calls both succeed on every server", [twin1, twin2].every((x) => x.body.members?.every((m) => m.ok)), JSON.stringify([twin1.body.members, twin2.body.members]));

    // --- the directory ---------------------------------------------------------------
    res = await a.call("/api/users", { method: "POST", body: JSON.stringify({ email: "dev@cluster.test", hours: 48 }) });
    r.check("A invites a user", res.status === 201 || res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
    const devId = res.body.user?.id ?? res.body.id;

    // The invited user, signed in, sees only what their permissions allow on
    // every server: no host metrics without `monitor`, no projects without grants.
    const inviteToken = String(res.body.invitePath ?? "").split("/").pop();
    const dev = client(base);
    res = await dev.call("/api/auth/invite", { method: "POST", body: JSON.stringify({ token: inviteToken, password: "dev-password-123" }) });
    r.check("the invited user sets a password", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
    await a.call("/api/cluster/sync", { method: "POST" });
    res = await dev.call("/api/cluster/servers");
    const devCard = res.body.servers?.find((s) => s.memberId === memberB.id);
    r.check("without monitor, no metrics from any server", res.status === 200 && res.body.servers.every((s) => s.summary === null || s.summary.metrics === null), JSON.stringify(res.body).slice(0, 300));
    r.check("and no projects counted where they have no grant", devCard?.summary?.projects.total === 0, JSON.stringify(devCard?.summary));
    res = await dev.call("/api/cluster/projects");
    r.check("the aggregated list is empty for them", res.status === 200 && (res.body.items ?? []).length === 0, JSON.stringify(res.body).slice(0, 200));

    res = await a.call("/api/cluster/sync", { method: "POST" });
    r.check("A syncs with B", res.status === 200 && res.body.members.every((m) => m.ok), JSON.stringify(res.body));

    res = await b.call("/api/users");
    const onB = (res.body.users ?? res.body).find?.((u) => u.email === "dev@cluster.test");
    r.check("the invited user appears on B", Boolean(onB), JSON.stringify(res.body).slice(0, 200));

    res = await b.call(`/api/users/${devId}`, {
      method: "PATCH",
      body: JSON.stringify({ access: { permissions: ["monitor"], grants: [{ scope: "project", scopeId: projectId, level: "read", terminal: false }] } }),
    });
    r.check("B edits the user's access", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
    res = await b.call("/api/cluster/sync", { method: "POST" });
    res = await a.call(`/api/users/${devId}`);
    r.check("the edit made on B is on A", res.body.access?.permissions?.includes("monitor") && res.body.access?.grants?.some((g) => g.scopeId === projectId), JSON.stringify(res.body.access));

    res = await a.call(`/api/users/${devId}`, { method: "DELETE" });
    r.check("A deletes the user", res.status === 200, `${res.status}`);
    await a.call("/api/cluster/sync", { method: "POST" });
    res = await b.call("/api/users");
    const stillOnB = (res.body.users ?? res.body).find?.((u) => u.email === "dev@cluster.test");
    r.check("the deletion reaches B", !stillOnB, JSON.stringify(stillOnB));

    res = await a.call("/api/settings", { method: "PUT", body: JSON.stringify({ github_token: "ghp_cluster_token" }) });
    r.check("A stores a GitHub token", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
    await a.call("/api/cluster/sync", { method: "POST" });
    res = await b.call("/api/settings");
    r.check("the GitHub token is present on B", res.body.github_token === "configured", JSON.stringify(res.body.github_token));

    // --- diagnosis -------------------------------------------------------------------
    res = await a.call(`/api/cluster/members/${memberB.id}/diagnose`, { method: "POST" });
    r.check(
      "the diagnosis is all green",
      res.status === 200 && res.body.reachable && res.body.signatureOk && res.body.sameCluster && res.body.versionMatch && res.body.skewOk && res.body.directoryMatch,
      JSON.stringify(res.body)
    );

    // --- secret rotation --------------------------------------------------------------
    res = await a.call(`/api/cluster/members/${memberB.id}/resend-secret`, { method: "POST" });
    r.check("re-sending the secret with no recent rotation is refused", res.status === 409, `${res.status} ${JSON.stringify(res.body)}`);
    res = await a.call("/api/cluster/members/no-such-member/resend-secret", { method: "POST" });
    r.check("re-sending to an unknown member is a 404", res.status === 404, String(res.status));

    res = await a.call("/api/cluster/rotate-secret", { method: "POST" });
    r.check("the secret rotates on every member", res.status === 200 && res.body.members.every((m) => m.ok), JSON.stringify(res.body));
    res = await a.call(`/api/cluster/members/${memberB.id}/diagnose`, { method: "POST" });
    r.check("they still talk after the rotation", res.body.signatureOk === true && res.body.reachable === true, JSON.stringify(res.body));
    res = await b.call("/api/cluster/sync", { method: "POST" });
    r.check("B can still reach A", res.status === 200 && res.body.members.every((m) => m.ok), JSON.stringify(res.body));
    // Inside the grace period the current secret can be handed out again,
    // signed with the previous one the member still accepts.
    res = await a.call(`/api/cluster/members/${memberB.id}/resend-secret`, { method: "POST" });
    r.check("the secret can be re-sent after a rotation", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
    res = await a.call(`/api/cluster/members/${memberB.id}/diagnose`, { method: "POST" });
    r.check("and the two still agree on it", res.body.signatureOk === true && res.body.reachable === true, JSON.stringify(res.body));

    // --- B becomes a managed node -------------------------------------------------------
    res = await a.call(`/api/cluster/members/${memberB.id}`, { method: "PATCH", body: JSON.stringify({ role: "node" }) });
    r.check("A turns B into a node", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
    res = await b.call("/api/auth/check");
    r.check("B says it is managed by A", res.body.role === "node" && res.body.managedBy?.some((m) => m.url === base), JSON.stringify(res.body));
    res = await b.call("/api/auth/login", { method: "POST", body: JSON.stringify({ email: OWNER, password: PASSWORD }) });
    r.check("nobody signs in on a node", res.status === 403, `${res.status}`);
    res = await b.call("/api/projects");
    r.check("B's old session is gone", res.status === 401, `${res.status}`);
    res = await a.call(`/api/nodes/${memberB.id}/projects`);
    r.check("A still manages B's projects", res.status === 200 && res.body.some((p) => p.id === projectId), `${res.status}`);

    // An edit made on the node through the proxy must come back on its own:
    // the node pushes, it does not wait for the panel's poll.
    res = await a.call("/api/users", { method: "POST", body: JSON.stringify({ email: "ops@cluster.test", hours: 48 }) });
    const opsId = res.body.user.id;
    await a.call("/api/cluster/sync", { method: "POST" });
    res = await a.call(`/api/nodes/${memberB.id}/users/${opsId}`, {
      method: "PATCH",
      body: JSON.stringify({ access: { permissions: ["storage"], grants: [{ scope: "project", scopeId: projectId, level: "operate", terminal: false }] } }),
    });
    r.check("the grant is written on the node", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
    let pushed = false;
    for (let i = 0; i < 20 && !pushed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      res = await a.call(`/api/users/${opsId}`);
      pushed = Boolean(res.body.access?.permissions?.includes("storage"));
    }
    r.check("the node pushes the edit to the panel by itself", pushed, JSON.stringify(res.body.access));

    // --- revocation ----------------------------------------------------------------------
    res = await a.call(`/api/cluster/members/${memberB.id}`, { method: "DELETE" });
    r.check("A revokes B", res.status === 200 && res.body.told === true, `${res.status} ${JSON.stringify(res.body)}`);
    res = await a.call("/api/cluster");
    r.check("A no longer lists B", res.body.members.length === 1, JSON.stringify(res.body));
    res = await b.call("/api/auth/check");
    r.check("B is on its own again, still set up", res.body.role === null && res.body.firstRun === false, JSON.stringify(res.body));
    res = await b.call("/api/auth/login", { method: "POST", body: JSON.stringify({ email: OWNER, password: PASSWORD }) });
    r.check("the owner can sign in on the revoked B", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
    res = await b.call("/api/cluster");
    r.check("B reports solo", res.body.solo === true, JSON.stringify(res.body));
  } finally {
    await serverB.stop();
  }

  return r.result();
}
