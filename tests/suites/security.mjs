import { createHmac } from "node:crypto";
import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * The unauthenticated surface: claiming the panel, guessing its password, and
 * what a caller with no cookie can reach.
 *
 * Run with one trusted proxy in front, because that is the deployment the
 * `X-Forwarded-For` handling has to be correct for — and the configuration in
 * which the old code was most obviously wrong. nginx APPENDS the real address
 * to whatever the client sent, so the entry a client controls is the FIRST one,
 * which is exactly the one the panel used to count by.
 */
export const meta = {
  name: "security",
  needsDocker: false,
  drivers: ["sqlite", "postgres"],
  env: { RUNPANEL_TRUSTED_PROXY_HOPS: "1" },
};

const PASSWORD = "security-suite-pw";

/** One request as it would arrive through a proxy that appended `real`. */
function viaProxy(api, path, body, { claimed, real }) {
  const chain = claimed ? `${claimed}, ${real}` : real;
  return api.call(path, {
    method: "POST",
    headers: { "x-forwarded-for": chain },
    body: JSON.stringify(body),
  });
}

export async function run({ base }) {
  const r = createReporter("security");

  // --- first-run setup needs the token -------------------------------------
  const stranger = client(base);

  let res = await stranger.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, password: "whoever-gets-here-first" }),
  });
  r.check("setup without a token is refused", res.status === 403, `status ${res.status}`);

  res = await stranger.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, password: "whoever-gets-here-first", setupToken: "guess" }),
  });
  r.check("setup with the wrong token is refused", res.status === 403, `status ${res.status}`);

  r.check(
    "a refused setup leaves the panel unclaimed",
    (await stranger.call("/api/auth/check")).body.firstRun === true
  );

  const owner = client(base);
  res = await owner.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, password: PASSWORD, setupToken: SETUP_TOKEN }),
  });
  r.check("setup with the right token succeeds", res.body.success === true, JSON.stringify(res.body));

  res = await stranger.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, password: "too-late", setupToken: SETUP_TOKEN }),
  });
  r.check("the panel cannot be claimed twice", res.status !== 200, `status ${res.status}`);

  // --- unauthenticated callers reach nothing -------------------------------
  const nobody = client(base);
  for (const path of ["/api/projects", "/api/services", "/api/settings", "/api/monitor"]) {
    r.check(`${path} refuses a caller with no session`, (await nobody.call(path)).status === 401);
  }

  // --- the login limiter cannot be reset by a header -----------------------
  const attacker = client(base);
  let limited = false;

  for (let i = 0; i < 8 && !limited; i++) {
    const attempt = await viaProxy(
      attacker,
      "/api/auth/login",
      { password: "wrong" },
      { real: "203.0.113.7" }
    );
    if (attempt.status === 429) limited = true;
  }
  r.check("repeated bad passwords from one address are limited", limited);

  // The regression. Prepending an address of the attacker's choosing used to
  // produce a brand-new counter on every request.
  const spoofed = await viaProxy(
    attacker,
    "/api/auth/login",
    { password: "wrong" },
    { claimed: "198.51.100.99", real: "203.0.113.7" }
  );
  r.check(
    "a forged X-Forwarded-For entry does not grant a fresh allowance",
    spoofed.status === 429,
    `status ${spoofed.status}`
  );

  const rotated = await viaProxy(
    attacker,
    "/api/auth/login",
    { password: "wrong" },
    { claimed: "198.51.100.1, 198.51.100.2", real: "203.0.113.7" }
  );
  r.check(
    "nor does a whole forged chain",
    rotated.status === 429,
    `status ${rotated.status}`
  );

  // A different real client is still allowed in — the limit is per address,
  // not a global lockout that one attacker can impose on everybody.
  const bystander = await viaProxy(
    client(base),
    "/api/auth/login",
    { password: PASSWORD },
    { real: "203.0.113.200" }
  );
  r.check(
    "a genuinely different address is unaffected",
    bystander.status === 200,
    `status ${bystander.status}`
  );

  // --- concurrent attempts are counted, not collapsed ----------------------
  const parallel = client(base);
  const burst = await Promise.all(
    Array.from({ length: 12 }, () =>
      viaProxy(parallel, "/api/auth/login", { password: "wrong" }, { real: "203.0.113.42" })
    )
  );
  const refused = burst.filter((x) => x.status === 429).length;
  r.check(
    "twelve simultaneous guesses do not all pass a limit of five",
    refused > 0,
    `${refused} of 12 refused`
  );

  // --- the webhook does not confirm which projects exist -------------------
  const unknown = await client(base).call("/api/webhooks/github/does-not-exist", {
    method: "POST",
    headers: { "x-github-event": "push", "x-hub-signature-256": "sha256=deadbeef" },
    body: JSON.stringify({ ref: "refs/heads/main" }),
  });
  r.check(
    "an unknown project is answered like a bad signature",
    unknown.status === 401,
    `status ${unknown.status}`
  );

  // --- a repository URL is not just "a URL" --------------------------------
  //
  // Cloning runs as the panel, on the panel's network, and git's
  // `http.extraheader` is not scoped to a host — so an unrestricted URL was
  // both an outbound request the caller chose and a way to be handed the
  // panel's GitHub token.
  const created = await owner.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Security Suite" }),
  });
  const projectId = created.body.id;

  const setSource = (sourceUrl) =>
    owner.call(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ sourceUrl }),
    });

  for (const [label, url] of [
    ["plain http", "http://github.com/user/repo.git"],
    ["file://", "file:///etc/passwd"],
    ["ssh://", "ssh://git@github.com/user/repo.git"],
    ["cloud metadata", "https://169.254.169.254/latest/meta-data/"],
    ["loopback", "https://127.0.0.1/repo.git"],
    ["a private range", "https://192.168.1.10/repo.git"],
  ]) {
    const refused = await setSource(url);
    r.check(`source URL: ${label} is refused`, refused.status === 400, `status ${refused.status}`);
  }

  const accepted = await setSource("https://github.com/user/repo.git");
  r.check("source URL: a public https repo is accepted", accepted.status === 200, `status ${accepted.status}`);

  // --- the webhook is still reachable --------------------------------------
  //
  // Worth asserting positively. `proxy.ts` answers 401 for anything it guards,
  // and so does a bad signature — so a matcher that accidentally covered
  // `/api/webhooks` would leave every existing test passing while auto-deploy
  // was quietly dead. A correct signature has to produce something else.
  await owner.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ autoDeploy: false }),
  });

  const project = await owner.call(`/api/projects/${projectId}`);
  const payload = JSON.stringify({ ref: "refs/heads/main" });
  const signature =
    "sha256=" +
    createHmac("sha256", project.body.webhook_secret).update(payload).digest("hex");

  const signed = await client(base).call(`/api/webhooks/github/${projectId}`, {
    method: "POST",
    headers: { "x-github-event": "push", "x-hub-signature-256": signature },
    body: payload,
  });
  r.check(
    "a correctly signed webhook reaches the handler",
    signed.status === 200,
    `status ${signed.status} ${JSON.stringify(signed.body)}`
  );

  // --- settings are an allowlist -------------------------------------------
  const settings = await owner.call("/api/settings");
  const leaked = Object.keys(settings.body).filter(
    (key) => !["polling_interval", "timezone", "accent_preset", "github_token"].includes(key)
  );
  r.check("settings returns only the keys a client needs", leaked.length === 0, leaked.join(","));
  r.check(
    "no password hash is ever echoed",
    !JSON.stringify(settings.body).includes("$2"),
    JSON.stringify(settings.body)
  );

  return r.result();
}
