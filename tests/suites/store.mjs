import { createHmac } from "node:crypto";
import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * The store contract: auth, projects, env vars, cascade deletes.
 *
 * Runs identically against SQLite and Postgres — the point of the suite is that
 * the two dialects behave the same, so any divergence shows up here.
 */
export const meta = { name: "store", needsDocker: false, drivers: ["sqlite", "postgres"] };

export async function run({ base }) {
  const r = createReporter("store");
  const api = client(base);

  // --- first run -----------------------------------------------------------
  let res = await api.call("/api/auth/check");
  r.check("fresh store reports first run", res.body.firstRun === true, JSON.stringify(res.body));
  r.check("fresh store is unauthenticated", res.body.authenticated === false);

  res = await api.call("/api/projects");
  r.check("projects require auth", res.status === 401, String(res.status));

  res = await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "store-suite-pw" }),
  });
  r.check("first-run setup succeeds", res.body.success === true, JSON.stringify(res.body));

  res = await api.call("/api/auth/check");
  r.check("session is authenticated", res.body.authenticated === true);
  r.check("first run is over", res.body.firstRun === false);

  // --- secrets never leave -------------------------------------------------
  res = await api.call("/api/settings");
  r.check(
    "settings never returns the password hash",
    !("admin_password_hash" in res.body),
    JSON.stringify(res.body).slice(0, 160)
  );
  r.check(
    "settings never returns a session token",
    !("session_token" in res.body),
    JSON.stringify(res.body).slice(0, 160)
  );

  // --- github source picker ------------------------------------------------
  // With no account connected the picker must render a "connect" prompt, so
  // "not connected" is reported as a normal 200 rather than an error status
  // the UI would have to special-case.
  res = await api.call("/api/github/repos");
  r.check("repos endpoint answers 200 with no token", res.status === 200, `${res.status}`);
  r.check("it reports the account as not connected", res.body.connected === false, JSON.stringify(res.body));
  r.check("repos is always an array", Array.isArray(res.body.repos), JSON.stringify(res.body.repos));

  // `repo` reaches a GitHub API path, so anything but owner/name is refused
  // before it can walk to a different endpoint.
  for (const bad of ["", "../../user", "owner", "owner/name/extra", "owner/../..%2fuser"]) {
    const bad_res = await api.call(`/api/github/branches?repo=${encodeURIComponent(bad)}`);
    r.check(`branches rejects "${bad || "(empty)"}"`, bad_res.status === 400, `${bad_res.status}`);
  }

  const unauth = await fetch(`${base}/api/github/repos`);
  r.check("repos endpoint requires auth", unauth.status === 401, `${unauth.status}`);

  // --- projects ------------------------------------------------------------
  res = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Store Suite" }),
  });
  const projectId = res.body.id;
  r.check("project created with a slug", res.body.slug === "store-suite", JSON.stringify(res.body));

  res = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Store Suite" }),
  });
  r.check("duplicate slug is rejected", res.status === 409, String(res.status));

  res = await api.call("/api/projects");
  const listed = res.body.find((p) => p.id === projectId);
  r.check("deploy_count is a number, not a bigint string", listed?.deploy_count === 0, String(listed?.deploy_count));
  r.check("last_deploy_at is null before any deploy", listed?.last_deploy_at === null, String(listed?.last_deploy_at));

  // --- env vars ------------------------------------------------------------
  res = await api.call(`/api/projects/${projectId}/env`, {
    method: "PUT",
    body: JSON.stringify({
      vars: [
        { key: "SECRET_ONE", value: "hunter2" },
        { key: "UNICODE_VAL", value: 'caffè — 日本語 🎉 "quoted"' },
      ],
    }),
  });
  r.check("env vars saved", res.body.count === 2, JSON.stringify(res.body));

  res = await api.call(`/api/projects/${projectId}/env`);
  r.check("values are masked by default", res.body[0]?.value === "••••••••", JSON.stringify(res.body));

  res = await api.call(`/api/projects/${projectId}/env?reveal=true`);
  const unicodeVar = res.body.find((v) => v.key === "UNICODE_VAL");
  r.check("plain value decrypts", res.body.some((v) => v.value === "hunter2"));
  r.check(
    "multi-byte value survives the crypto round-trip byte for byte",
    unicodeVar?.value === 'caffè — 日本語 🎉 "quoted"',
    JSON.stringify(unicodeVar?.value)
  );

  res = await api.call(`/api/projects/${projectId}/env`, {
    method: "PUT",
    body: JSON.stringify({ vars: [{ key: "ONLY_ONE", value: "x" }] }),
  });
  res = await api.call(`/api/projects/${projectId}/env`);
  r.check("replacing the set removes the old vars", !JSON.stringify(res.body).includes("SECRET_ONE"));

  res = await api.call(`/api/projects/${projectId}/env`, {
    method: "PUT",
    body: JSON.stringify({ vars: [{ key: "bad name", value: "x" }] }),
  });
  r.check("invalid env var name is rejected", res.status === 400, String(res.status));

  // --- updates -------------------------------------------------------------
  res = await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ autoDeploy: true, port: 4321 }),
  });
  r.check("boolean stored as 0/1 on both dialects", res.body.auto_deploy === 1, String(res.body.auto_deploy));
  r.check("port updated", res.body.port === 4321, String(res.body.port));

  // --- webhook -------------------------------------------------------------
  res = await api.call(`/api/webhooks/github/${projectId}`, {
    method: "POST",
    headers: { "x-github-event": "push", "x-hub-signature-256": "sha256=deadbeef" },
    body: JSON.stringify({ ref: "refs/heads/main" }),
  });
  r.check("webhook rejects a bad signature", res.status === 401, String(res.status));

  const secret = (await api.call(`/api/projects/${projectId}`)).body.webhook_secret;
  const sign = (body) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const deliver = (event, body, headers = {}) =>
    api.call(`/api/webhooks/github/${projectId}`, {
      method: "POST",
      headers: { "x-github-event": event, "x-hub-signature-256": sign(body), ...headers },
      body,
    });

  /*
    The push tests below run against a branch the project is not tracking, on
    purpose: a matching branch would start a real deploy of a project with no
    source URL, and the suite would be asserting webhook parsing while a build
    failed in the background. A mismatch answers from the same code path having
    read `ref`, which is the part under test.
  */
  await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ sourceBranch: "release" }),
  });

  const ping = JSON.stringify({ zen: "Design for failure.", hook_id: 1 });
  res = await deliver("ping", ping);
  r.check(
    "a ping is answered as a ping, not as an unknown event",
    res.status === 200 && /Pong/.test(res.body.message ?? ""),
    `${res.status} ${JSON.stringify(res.body)}`
  );

  // GitHub's webhook form offers both content types, and the signature is over
  // the raw body either way — so a form-encoded delivery is correctly signed and
  // used to die in JSON.parse as a bare 400.
  const inner = JSON.stringify({ ref: "refs/heads/main", head_commit: { id: "abc1234def", message: "m" } });
  const form = new URLSearchParams({ payload: inner }).toString();
  res = await deliver("push", form, { "content-type": "application/x-www-form-urlencoded" });
  r.check(
    "a form-encoded push is understood",
    res.status === 200 && res.body.message === "Branch mismatch",
    `${res.status} ${JSON.stringify(res.body)}`
  );

  res = await deliver("push", inner);
  r.check(
    "a json push is understood",
    res.status === 200 && res.body.message === "Branch mismatch",
    `${res.status} ${JSON.stringify(res.body)}`
  );

  // --- the panel can see what arrived --------------------------------------
  const unauthStatus = await fetch(`${base}/api/projects/${projectId}/webhook`);
  r.check("webhook status requires auth", unauthStatus.status === 401, String(unauthStatus.status));

  res = await api.call(`/api/projects/${projectId}/webhook`);
  const statuses = (res.body.deliveries ?? []).map((d) => d.status);
  r.check(
    "the panel records the deliveries it accepted",
    statuses.includes("accepted"),
    JSON.stringify(statuses)
  );
  r.check(
    "and the ones it ignored, with the reason",
    (res.body.deliveries ?? []).some((d) => d.summary?.reason === "branch mismatch"),
    JSON.stringify(res.body.deliveries?.slice(0, 3))
  );
  // Refusals used to be dropped entirely, which left the commonest setup
  // mistake — a wrong secret — with no evidence anywhere in the panel.
  r.check(
    "a refused delivery leaves a trace",
    statuses.includes("rejected"),
    JSON.stringify(statuses)
  );
  r.check(
    "status reports no hook without a GitHub token",
    res.body.connected === false && res.body.hook === null,
    JSON.stringify({ connected: res.body.connected, hook: res.body.hook })
  );

  res = await api.call(`/api/projects/${projectId}/webhook`, {
    method: "POST",
    body: JSON.stringify({ action: "nonsense" }),
  });
  r.check("an unknown webhook action is refused", res.status === 400, String(res.status));

  // --- polling as the other transport --------------------------------------
  //
  // The panel behind NAT, a VPN or Tailscale can never receive a webhook: the
  // delivery fails at connect, outside anything this code can see. Asking
  // GitHub on a timer is the same feature with the connection reversed, so the
  // two are one setting with two values rather than two features.
  res = await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ deployTrigger: "nope" }),
  });
  r.check("an unknown deploy trigger is refused", res.status === 400, String(res.status));

  // A project created from the panel starts as an upload, and neither transport
  // means anything without a repository to watch.
  await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({
      sourceType: "github",
      sourceUrl: "https://github.com/runpanel/store-suite.git",
    }),
  });

  res = await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ deployTrigger: "poll" }),
  });
  r.check("the project can switch to polling", res.body.deploy_trigger === "poll", JSON.stringify(res.body.deploy_trigger));

  res = await api.call(`/api/projects/${projectId}/webhook`);
  r.check("status reports the polling transport", res.body.trigger === "poll", JSON.stringify(res.body.trigger));
  r.check(
    "and the interval it will use",
    res.body.poll?.intervalSeconds === 300 && res.body.poll?.intervalLabel === "5 minuti",
    JSON.stringify(res.body.poll)
  );

  // Under polling there is no hook, no public URL and no deliveries to be right
  // or wrong about — reporting them anyway is a diagnostic nobody keeps reading.
  const pollChecks = (res.body.checks ?? []).map((c) => c.id);
  r.check(
    "the checks drop the webhook vocabulary",
    !pollChecks.includes("hook") && !pollChecks.includes("public-url"),
    JSON.stringify(pollChecks)
  );
  r.check("and describe the polling instead", pollChecks.includes("poll"), JSON.stringify(pollChecks));

  const interval = await api.call("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ preferences: { deploy_poll_interval: "30" } }),
  });
  r.check("30 seconds is an accepted interval", interval.status === 200, String(interval.status));

  res = await api.call(`/api/projects/${projectId}/webhook`);
  r.check(
    "a sub-minute interval is spelled in seconds",
    res.body.poll?.intervalLabel === "30 secondi",
    JSON.stringify(res.body.poll)
  );

  res = await api.call("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ preferences: { deploy_poll_interval: "7" } }),
  });
  r.check("an interval off the list is refused", res.status === 400, String(res.status));

  // Switching away forgets the commit, or coming back would compare today's
  // branch against a months-old SHA and deploy on the spot.
  res = await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ deployTrigger: "webhook" }),
  });
  r.check(
    "leaving polling clears the recorded commit",
    res.body.deploy_trigger === "webhook" && res.body.poll_sha === null,
    JSON.stringify({ trigger: res.body.deploy_trigger, sha: res.body.poll_sha })
  );

  // --- 404s ----------------------------------------------------------------
  res = await api.call("/api/projects/does-not-exist");
  r.check("unknown project returns 404", res.status === 404, String(res.status));

  // --- cascade delete ------------------------------------------------------
  res = await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  r.check("project deleted", res.body.success === true, JSON.stringify(res.body));

  res = await api.call(`/api/projects/${projectId}/env`);
  r.check("child rows went with the parent", res.status === 404, String(res.status));

  // --- logout --------------------------------------------------------------
  await api.call("/api/auth/logout", { method: "POST" });
  res = await api.call("/api/projects");
  r.check("logout invalidates the session", res.status === 401, String(res.status));

  return r.result();
}
