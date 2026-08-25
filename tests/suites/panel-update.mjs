import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The self-update API, exercised without ever updating anything.
 *
 * That constraint is the whole design of this suite and is worth stating: the
 * test server runs `next start` from the real repository, so its `process.cwd()`
 * is this checkout. An `apply` that got as far as its work would `git reset
 * --hard` the tree somebody is developing in, reinstall their dependencies and
 * then exit the process mid-suite. So nothing here ever reaches that path —
 * every `apply` call is one that has to be refused before any work starts, and
 * each is a refusal worth having.
 *
 * What is left is still the part most likely to break: the four routes exist,
 * they are behind the session, they answer in the shape the page destructures,
 * and the settings allowlist really does cover the new key.
 */
export const meta = { name: "panel-update", needsDocker: false, drivers: ["sqlite", "postgres"] };

const ROUTES = [
  ["/api/updates", "GET"],
  ["/api/updates/check", "POST"],
  ["/api/updates/apply", "POST"],
  ["/api/updates/log", "GET"],
  ["/api/updates/stream", "GET"],
];

export async function run({ base, dataDir }) {
  const r = createReporter("panel-update");
  const api = client(base);

  // --- Nothing before the session ------------------------------------------
  //
  // `proxy.ts` denies `/api/*` by default, but the namespace is new: this is
  // the assertion that it was not accidentally added to an exempt prefix.
  for (const [path, method] of ROUTES) {
    const res = await api.call(path, { method });
    r.check(`${method} ${path} needs a session`, res.status === 401, String(res.status));
  }

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "panel-update-pw" }),
  });

  // --- The shape the page reads --------------------------------------------
  let res = await api.call("/api/updates");
  r.check("status answers 200", res.status === 200, String(res.status));

  const body = res.body;
  r.check("it reports a version", typeof body.version === "string" && body.version.length > 0, body.version);
  r.check("it describes the checkout", body.checkout && typeof body.checkout.isRepo === "boolean");
  r.check("it says whether this host can self-update", typeof body.canUpdate?.ok === "boolean");
  r.check(
    "and names a restart method",
    ["systemd", "cron", "container", "manual"].includes(body.canUpdate?.restart),
    body.canUpdate?.restart
  );
  r.check("nothing has been checked yet", body.check === null, JSON.stringify(body.check));
  r.check("no run has ever happened", body.run === null, JSON.stringify(body.run));
  r.check("nothing is in flight", body.busy === null, String(body.busy));
  r.check("it hands back the configured interval", typeof body.interval === "string", body.interval);

  // The panel's own repository is right there, so the probe should recognise it.
  // Reported rather than asserted: a checkout exported without `.git` is a
  // legitimate way to run the tests.
  r.note(
    body.checkout.isRepo
      ? `checkout: ${body.checkout.branch ?? "detached"} @ ${body.checkout.short ?? "?"}`
      : "the test server is not running from a git checkout"
  );
  r.note(`self-update here: ${body.canUpdate.ok ? "allowed" : "refused"} (${body.canUpdate.restart})`);

  // --- Refusals that happen before any work --------------------------------
  //
  // A malformed SHA is rejected in the handler, before the probe and long
  // before git is touched. `lib/git-ref.ts` explains why a value bound for a
  // git command is never taken on trust.
  for (const bad of ["nope", "1234567", "z".repeat(40), "../../etc/passwd", "4d480c7 --upload-pack=x"]) {
    const attempt = await api.call("/api/updates/apply", {
      method: "POST",
      body: JSON.stringify({ expectedSha: bad }),
    });
    r.check(`apply rejects "${bad.slice(0, 24)}"`, attempt.status === 400, String(attempt.status));
  }

  // --- The log of a run that does not exist --------------------------------
  res = await api.call("/api/updates/log");
  r.check("the log answers 200 with no run", res.status === 200, String(res.status));
  r.check("and reports no run", res.body.runId === null, JSON.stringify(res.body.runId));
  r.check("with no lines", Array.isArray(res.body.lines) && res.body.lines.length === 0);

  // --- The stream closes rather than hanging -------------------------------
  //
  // With nothing running there is nothing to follow, and a stream left open
  // would have `EventSource` sitting on a connection forever.
  const stream = await fetch(`${base}/api/updates/stream`, { headers: { cookie: api.cookie } });
  r.check(
    "the stream is server-sent events",
    (stream.headers.get("content-type") ?? "").includes("text/event-stream"),
    stream.headers.get("content-type")
  );
  r.check(
    "proxies are told not to buffer it",
    stream.headers.get("x-accel-buffering") === "no",
    stream.headers.get("x-accel-buffering")
  );

  const text = await withTimeout(stream.text(), 10_000, "");
  r.check("it replays a ready frame", text.includes('"type":"ready"'), text.slice(0, 120));
  r.check("and ends on its own", text.includes('"panel-update:status"'), text.slice(0, 200));

  // --- The interval is a real preference -----------------------------------
  res = await api.call("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ preferences: { panel_update_interval: "3600" } }),
  });
  r.check("a listed interval is accepted", res.status === 200, String(res.status));

  res = await api.call("/api/settings");
  r.check("and is read back", res.body.panel_update_interval === "3600", res.body.panel_update_interval);

  res = await api.call("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ preferences: { panel_update_interval: "300" } }),
  });
  r.check("an unlisted one is refused", res.status === 400, String(res.status));

  res = await api.call("/api/updates");
  r.check("the status echoes the saved interval", res.body.interval === "3600", res.body.interval);

  // --- Signature verification is off until it is asked for ------------------
  //
  // The default matters more than the mechanism: turning this on for everybody
  // would stop the update button working on every panel whose operator does not
  // sign commits.
  res = await api.call("/api/settings");
  r.check(
    "signature verification defaults to off",
    res.body.panel_update_require_signature !== "1",
    String(res.body.panel_update_require_signature)
  );

  res = await api.call("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ preferences: { panel_update_require_signature: "1" } }),
  });
  r.check("it can be turned on", res.status === 200, String(res.status));

  res = await api.call("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ preferences: { panel_update_require_signature: "yes" } }),
  });
  r.check("but only with a value the allowlist knows", res.status === 400, String(res.status));

  res = await api.call("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ panel_update_allowed_signers: "tu@esempio.it ssh-ed25519 AAAAC3Nza" }),
  });
  r.check("allowed signers are accepted", res.status === 200, String(res.status));

  res = await api.call("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ panel_update_allowed_signers: "x".repeat(9000) }),
  });
  r.check("an oversized paste is refused", res.status === 400, String(res.status));

  // Turned back off so the rest of the suite, and any run after it, is not left
  // with a control the developer did not switch on.
  await api.call("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ preferences: { panel_update_require_signature: "0" } }),
  });

  // --- Where a copy of the whole store is allowed to sit --------------------
  //
  // `<dataDir>/panel-update/` holds a full dump of the panel's database on the
  // way into an update — encrypted env vars, registry logins, session hashes.
  // It used to be created 0755 by an inline `path.join`, outside the only 0700
  // tree in the repository.
  if (process.platform === "win32") {
    r.note("skip data directory mode checks (Windows filesystems do not carry POSIX modes)");
  } else {
    const updateDir = join(dataDir, "panel-update");
    r.check("the update directory exists at boot", existsSync(updateDir), updateDir);
    if (existsSync(updateDir)) {
      const mode = statSync(updateDir).mode & 0o777;
      r.check("and is 0700", mode === 0o700, `mode ${mode.toString(8)}`);
    }

    // The regression guard beside it: the chmod that already protected backups
    // became a loop, and a loop is easier to get wrong than a single call.
    const backupsDir = join(dataDir, "backups");
    if (existsSync(backupsDir)) {
      const mode = statSync(backupsDir).mode & 0o777;
      r.check("backups are still 0700", mode === 0o700, `mode ${mode.toString(8)}`);
    }
  }

  return r.result();
}

/** The stream should close by itself; this makes a hang a failure, not a hang. */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}
