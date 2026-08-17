import { client, createReporter, sleep, waitForDeploy, SETUP_TOKEN } from "../harness.mjs";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The native runtime, against a real PM2.
 *
 * Docker had four suites and PM2 had none, even though half the panel's users
 * are on the native path and it is the one with the most host-specific code:
 * PM2 strips the system PATH when it forks, so the driver writes a generated
 * wrapper to put it back, and that wrapper is the file that once contained
 * every one of the project's secrets in cleartext.
 *
 * Nothing here is Windows- or Linux-specific by design. The one assertion that
 * cannot hold on both — a 0600 file mode, which Windows filesystems do not
 * carry — is guarded by platform rather than dropped, so the stronger check
 * still runs where the panel actually gets deployed.
 */
export const meta = { name: "native-runtime", needsDocker: false, needsPm2: true, drivers: ["sqlite"] };

const PORT = 3314;
const SECRET = "native-suite-s3cr3t";

/** Portable no-ops: no shell builtins, no redirection, identical on cmd and sh. */
const INSTALL_CMD = "node --version";
const RELEASE_CMD = `node -e "require('fs').writeFileSync('released.txt','released-ok')"`;

function writeApp(repo) {
  mkdirSync(repo, { recursive: true });

  // No dependencies and no build script: this suite is about the runtime, not
  // about npm. An install that reached the network would make it flaky for a
  // reason that has nothing to do with the code under test.
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "native-suite-app", version: "1.0.0", private: true }, null, 2)
  );

  writeFileSync(
    join(repo, "server.js"),
    `const http = require("http");
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; } };
const port = Number(process.env.PORT) || 0;

http.createServer((req, res) => {
  if (req.url !== "/healthz") { res.writeHead(404); res.end("not here"); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    pid: process.pid,
    port,
    secretFromEnv: process.env.SECRET_TOKEN || null,
    nodeEnv: process.env.NODE_ENV || null,
    cwd: process.cwd(),
    files: (() => { try { return fs.readdirSync("."); } catch { return null; } })(),
    envFile: read(".env"),
    releaseMarker: read("released.txt"),
  }));
}).listen(port, "127.0.0.1");

console.log("native-suite listening on " + port);
`
  );
}

export async function run({ base, dataDir }) {
  const r = createReporter("native-runtime");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "native-suite-pw" }),
  });

  const created = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Native Suite" }),
  });
  const projectId = created.body.id;
  const slug = created.body.slug;
  const repo = join(dataDir, "repos", slug);

  writeApp(repo);

  await api.call(`/api/projects/${projectId}/env`, {
    method: "PUT",
    body: JSON.stringify({ vars: [{ key: "SECRET_TOKEN", value: SECRET }] }),
  });

  const patched = await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({
      runtimeType: "node",
      sourceType: "upload",
      port: PORT,
      builderConfig: {
        version: 1,
        commands: { install: INSTALL_CMD, build: "", start: "node server.js", release: RELEASE_CMD },
        // For a native runtime there is nothing to mount: the file goes into the
        // working directory the process will run from.
        envFile: { enabled: true, path: ".env" },
        healthcheck: {
          enabled: true,
          path: "/healthz",
          expectStatus: [200],
          startPeriodSec: 2,
          timeoutSec: 90,
          intervalSec: 2,
        },
      },
    }),
  });
  r.check("native contract accepted", patched.status === 200, `${patched.status} ${JSON.stringify(patched.body).slice(0, 160)}`);

  const deploy = await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
  r.check("deploy accepted", deploy.status === 202, String(deploy.status));

  const status = await waitForDeploy(api, projectId);
  r.check("deploy reached running", status === "running", `status=${status}`);

  if (status !== "running") {
    const history = await api.call(`/api/projects/${projectId}/logs`);
    const failed = (history.body ?? []).find((d) => d.status === "failed");
    if (failed) {
      const full = await api.call(`/api/deployments/${failed.id}?tail=30`);
      r.note("--- build log tail ---");
      for (const line of String(full.body?.build_log ?? "").trim().split("\n")) r.note(line);
    }
    await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
    return r.result();
  }

  // --- the process is genuinely up ------------------------------------------
  const probe = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((x) => x.json());
  // The working directory and its contents are reported because every failure
  // in this suite so far has been answered by them: a command that ran in the
  // wrong place, or one that ran in the right place and wrote nothing.
  r.note(`app reports: ${JSON.stringify({
    port: probe.port,
    nodeEnv: probe.nodeEnv,
    secretFromEnv: probe.secretFromEnv ? "<set>" : null,
    releaseMarker: probe.releaseMarker,
    files: probe.files,
  })}`);

  r.check("the app answers on the port the panel assigned", probe.port === PORT, String(probe.port));
  r.check("runtime env vars reached the process", probe.secretFromEnv === SECRET);
  r.check("NODE_ENV defaults to production", probe.nodeEnv === "production", String(probe.nodeEnv));
  r.check("release command ran before start", probe.releaseMarker === "released-ok", String(probe.releaseMarker));

  if (probe.releaseMarker !== "released-ok") {
    const history = await api.call(`/api/projects/${projectId}/logs`);
    const last = (history.body ?? [])[0];
    if (last) {
      const full = await api.call(`/api/deployments/${last.id}`);
      r.note("--- build log ---");
      for (const line of String(full.body?.build_log ?? "").trim().split("\n")) r.note(line);
    }
  }
  r.check(
    "the env file was written into the working directory",
    typeof probe.envFile === "string" && probe.envFile.includes("SECRET_TOKEN"),
    String(probe.envFile).slice(0, 80)
  );

  // --- the generated wrapper carries no secrets -----------------------------
  //
  // The regression this exists for: the wrapper used to inline every variable
  // of the project into a world-readable .js. It now reads a 0600 sidecar, and
  // the two halves of that arrangement are asserted separately — a wrapper that
  // stopped reading the sidecar would still pass a test that only checked the
  // sidecar's mode.
  // The wrapper comes in two flavours: a shell script that `exec`s the command
  // where there is a POSIX shell, and the Node one everywhere else. They are
  // asserted through the same checks — only the file names differ.
  const posix = process.platform !== "win32";
  const pm2Dir = join(dataDir, "pm2");
  const wrapper = join(pm2Dir, `${slug}${posix ? ".sh" : ".js"}`);
  const sidecar = join(pm2Dir, `${slug}${posix ? ".env.sh" : ".env.json"}`);

  r.check("a wrapper was generated", existsSync(wrapper));
  r.check("an env sidecar was generated", existsSync(sidecar));

  if (posix) {
    // The point of the shell flavour: the shell is replaced by the app, so what
    // PM2 supervises is the app itself. A wrapper that forked instead would
    // leave PM2 measuring and signalling a parent that never grows and never
    // dies — which is what `max_memory_restart` used to watch.
    r.check(
      "the wrapper execs the command instead of forking it",
      existsSync(wrapper) && /^exec /m.test(readFileSync(wrapper, "utf8")),
      "no `exec` line in the wrapper"
    );
    // Migrating from the Node flavour has to take the old sidecar with it: that
    // file holds every secret of the project in cleartext.
    r.check("no Node wrapper is left behind", !existsSync(join(pm2Dir, `${slug}.js`)));
    r.check("no Node sidecar is left behind", !existsSync(join(pm2Dir, `${slug}.env.json`)));
  }
  r.check(
    "the wrapper does not contain the project's secrets",
    existsSync(wrapper) && !readFileSync(wrapper, "utf8").includes(SECRET)
  );
  r.check(
    "the sidecar is what holds them",
    existsSync(sidecar) && readFileSync(sidecar, "utf8").includes(SECRET)
  );

  if (process.platform === "win32") {
    r.note("skip sidecar 0600 check (Windows filesystems do not carry POSIX modes)");
  } else {
    const mode = statSync(sidecar).mode & 0o777;
    r.check("the sidecar is 0600", mode === 0o600, `mode ${mode.toString(8)}`);
  }

  // --- what the driver reports back -----------------------------------------
  const live = await api.call(`/api/projects/${projectId}/status`);
  r.check("status reports the process as running", live.body?.process?.running === true, JSON.stringify(live.body));
  r.check("with a pid", Number.isInteger(live.body?.process?.pid), JSON.stringify(live.body?.process));

  if (posix) {
    // The app reports its own pid on /healthz, so the two can be compared: with
    // the wrapper `exec`ing, they are the same process. Under the forking
    // wrapper this was the app's parent, and every per-process thing PM2 did —
    // memory readings, the stop signal, `max_memory_restart` — landed on it.
    r.check(
      "the pid PM2 supervises is the app's own",
      live.body?.process?.pid === probe.pid,
      `pm2 ${live.body?.process?.pid} vs app ${probe.pid}`
    );
  }

  const outLog = join(dataDir, "logs", "pm2", `${slug}-out.log`);
  r.check(
    "stdout is captured to the log file the tailer follows",
    existsSync(outLog) && readFileSync(outLog, "utf8").includes("native-suite listening"),
    outLog
  );

  // --- stop and start again --------------------------------------------------
  await api.call(`/api/projects/${projectId}/control`, {
    method: "POST",
    body: JSON.stringify({ action: "stop" }),
  });
  await sleep(2000);
  const stopped = await api.call(`/api/projects/${projectId}/status`);
  r.check("stopping the project stops the process", stopped.body?.process?.running !== true, JSON.stringify(stopped.body));

  let unreachable = false;
  try {
    await fetch(`http://127.0.0.1:${PORT}/healthz`);
  } catch {
    unreachable = true;
  }
  r.check("and the port stops answering", unreachable);

  await api.call(`/api/projects/${projectId}/control`, {
    method: "POST",
    body: JSON.stringify({ action: "start" }),
  });

  let restarted = false;
  for (let i = 0; i < 20 && !restarted; i++) {
    await sleep(1000);
    const again = await api.call(`/api/projects/${projectId}/status`);
    restarted = again.body?.process?.running === true;
  }
  r.check("starting it again brings the same app back", restarted);

  // --- deleting the app takes its files with it ------------------------------
  //
  // The sidecar is full of decrypted secrets: leaving it behind after the app
  // is gone is the failure `pm2ArtifactPaths` was introduced to prevent.
  const removed = await api.call(`/api/projects/${projectId}/app`, { method: "DELETE" });
  r.check("the app can be removed", removed.status === 200, `${removed.status} ${JSON.stringify(removed.body).slice(0, 120)}`);
  await sleep(1500);

  r.check("the wrapper is gone", !existsSync(wrapper));
  r.check("the secret-bearing sidecar is gone", !existsSync(sidecar));

  // --- a contract cannot write the env file outside the project --------------
  //
  // Native runtimes have no container boundary: `envFile.path` is resolved
  // against the checkout, and this file holds every decrypted variable. The
  // containment check used to be a bare `startsWith`.
  const second = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Native Escape" }),
  });
  const escapeId = second.body.id;
  const escapeSlug = second.body.slug;
  writeApp(join(dataDir, "repos", escapeSlug));

  await api.call(`/api/projects/${escapeId}/env`, {
    method: "PUT",
    body: JSON.stringify({ vars: [{ key: "SECRET_TOKEN", value: SECRET }] }),
  });

  await api.call(`/api/projects/${escapeId}`, {
    method: "PATCH",
    body: JSON.stringify({
      runtimeType: "node",
      sourceType: "upload",
      port: PORT + 1,
      builderConfig: {
        version: 1,
        commands: { install: INSTALL_CMD, build: "", start: "node server.js" },
        envFile: { enabled: true, path: "../escaped.env" },
        healthcheck: { enabled: false },
      },
    }),
  });

  await api.call(`/api/projects/${escapeId}/deploy`, { method: "POST", body: "{}" });
  const escapeStatus = await waitForDeploy(api, escapeId);
  r.check(
    "an envFile.path pointing outside the checkout fails the deploy",
    escapeStatus !== "running",
    `status=${escapeStatus}`
  );
  r.check(
    "and nothing was written where it pointed",
    !existsSync(join(dataDir, "repos", "escaped.env"))
  );

  await api.call(`/api/projects/${escapeId}`, { method: "DELETE" });
  await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  return r.result();
}
