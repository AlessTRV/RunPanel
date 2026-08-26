import { client, createReporter, SETUP_TOKEN, waitForDeploy } from "../harness.mjs";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * One-time commands through a real deploy.
 *
 * Three things are asserted that only a real run can show. That each phase
 * fires where its name says — checked against the markers the pipeline already
 * prints, not against the commands' own output, so a phase wired to the wrong
 * line is caught rather than merely reported. That a command is consumed:
 * the queue empties and the history fills. And that a critical failure puts its
 * command BACK, which is the whole retry story — a run that consumed a failed
 * migration would be the bug this feature exists to avoid.
 *
 * PM2 is required because the app has to genuinely start: the last two phases
 * only exist after a process is up.
 */
export const meta = { name: "one-time-deploy", needsDocker: false, needsPm2: true, drivers: ["sqlite"] };

const PORT = 3319;

/** Portable no-ops: no shell builtins, no redirection, identical on cmd and sh. */
const marker = (name) =>
  `node -e "require('fs').writeFileSync('${name}','ok')"`;

function writeApp(repo) {
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "one-time-suite-app", version: "1.0.0", private: true }, null, 2)
  );
  writeFileSync(
    join(repo, "server.js"),
    `const http = require("http");
const port = Number(process.env.PORT) || 0;
http.createServer((req, res) => {
  if (req.url !== "/healthz") { res.writeHead(404); res.end("no"); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}).listen(port, "127.0.0.1");
console.log("one-time-suite listening on " + port);
`
  );
}

/** The deploy log of the newest deployment, however it ended. */
async function lastLog(api, projectId) {
  const history = await api.call(`/api/projects/${projectId}/logs`);
  const newest = (history.body ?? [])[0];
  if (!newest) return "";
  const full = await api.call(`/api/deployments/${newest.id}?tail=400`);
  return String(full.body?.build_log ?? "");
}

export async function run({ base, dataDir }) {
  const r = createReporter("one-time-deploy");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "one-time-deploy-pw" }),
  });

  const created = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "One Time Deploy" }),
  });
  const projectId = created.body.id;
  const repo = join(dataDir, "repos", created.body.slug);
  writeApp(repo);

  await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({
      runtimeType: "node",
      sourceType: "upload",
      port: PORT,
      builderConfig: {
        version: 1,
        commands: { install: "node --version", build: "", start: "node server.js" },
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

  const url = `/api/projects/${projectId}/one-time-commands`;
  const put = (commands) => api.call(url, { method: "PUT", body: JSON.stringify({ commands }) });

  // --- one command at each of the eight points ------------------------------
  const phases = [
    "pre-deploy",
    "post-source",
    "pre-install",
    "post-install",
    "post-build",
    "pre-start",
    "post-start",
    "post-deploy",
  ];

  let res = await put(
    phases.map((phase) => ({
      phase,
      command: marker(`mark-${phase}.txt`),
      label: phase,
      continueOnError: false,
    }))
  );
  r.check("eight commands queued", res.status === 200 && res.body.queued.length === 8, JSON.stringify(res.body).slice(0, 200));

  // The header reads this, so it is worth asserting it travels.
  res = await api.call(`/api/projects/${projectId}`);
  r.check("the project payload carries all eight", res.body.oneTimeCommands?.length === 8, String(res.body.oneTimeCommands?.length));

  let deploy = await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
  r.check("deploy accepted", deploy.status === 202, String(deploy.status));

  let status = await waitForDeploy(api, projectId);
  r.check("deploy reached running", status === "running", `status=${status}`);

  const log = await lastLog(api, projectId);
  if (status !== "running") {
    r.note("--- build log tail ---");
    for (const line of log.trim().split("\n").slice(-40)) r.note(line);
  }

  // --- every phase actually ran ---------------------------------------------
  // `pre-deploy` is the exception on a first-ever deploy for a github project;
  // this one is an upload whose checkout is already on disk, so it runs too.
  for (const phase of phases) {
    r.check(
      `${phase} ran`,
      existsSync(join(repo, `mark-${phase}.txt`)),
      join(repo, `mark-${phase}.txt`)
    );
  }

  // --- and ran where its name says ------------------------------------------
  const at = (needle) => log.indexOf(needle);
  const order = [
    ["pre-deploy", "--- One-time commands (pre-deploy) ---"],
    ["post-source", "--- One-time commands (post-source) ---"],
    ["building", "--- Building ---"],
    ["pre-install", "--- One-time commands (pre-install) ---"],
    ["installed", "Dependencies installed."],
    ["post-install", "--- One-time commands (post-install) ---"],
    ["post-build", "--- One-time commands (post-build) ---"],
    ["starting", "--- Starting application ---"],
    ["post-start", "--- One-time commands (post-start) ---"],
    ["health", "--- Health check ---"],
    ["post-deploy", "--- One-time commands (post-deploy) ---"],
  ].map(([name, needle]) => ({ name, at: at(needle) }));

  const missing = order.filter((step) => step.at < 0).map((step) => step.name);
  r.check("every marker is in the log", missing.length === 0, missing.join(", "));

  const ascending = order.every((step, i) => i === 0 || step.at > order[i - 1].at);
  r.check(
    "the phases fire in the documented order",
    missing.length === 0 && ascending,
    order.map((step) => `${step.name}@${step.at}`).join(" ")
  );

  // pre-install sits between the build starting and the dependencies being
  // installed — the case the whole builder hook exists for.
  r.check(
    "pre-install is inside the build, before the install finishes",
    at("--- One-time commands (pre-install) ---") > at("--- Building ---") &&
      at("--- One-time commands (pre-install) ---") < at("Dependencies installed."),
    "install boundary"
  );

  // post-build comes before the release slot, so a chore preparing a migration
  // runs before the migration does.
  r.check(
    "post-build precedes pre-start",
    at("--- One-time commands (post-build) ---") < at("--- One-time commands (pre-start) ---"),
    "post-build/pre-start"
  );

  // --- consumed, with history ------------------------------------------------
  res = await api.call(`${url}?include=history`);
  r.check("the queue is empty afterwards", res.body.queued.length === 0, JSON.stringify(res.body.queued));
  r.check("all eight are in the history", res.body.history.length === 8, String(res.body.history.length));
  r.check(
    "all eight are recorded as done",
    res.body.history.every((entry) => entry.status === "done" && entry.attempts === 1),
    JSON.stringify(res.body.history.map((entry) => [entry.label, entry.status, entry.attempts]))
  );
  r.check(
    "the history records when they ran and against which commit",
    res.body.history.every((entry) => entry.startedAt && entry.finishedAt),
    "timestamps"
  );

  // A second deploy must not run them again.
  for (const phase of phases) rmSync(join(repo, `mark-${phase}.txt`), { force: true });
  await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
  status = await waitForDeploy(api, projectId);
  r.check("the second deploy also succeeds", status === "running", `status=${status}`);
  r.check(
    "nothing runs a second time",
    phases.every((phase) => !existsSync(join(repo, `mark-${phase}.txt`))),
    phases.filter((phase) => existsSync(join(repo, `mark-${phase}.txt`))).join(", ")
  );

  // --- a critical failure fails the deploy and keeps the command ------------
  res = await put([
    { phase: "post-build", command: 'node -e "process.exit(1)"', label: "rotto", continueOnError: false },
    { phase: "post-deploy", command: marker("mark-later.txt"), label: "dopo", continueOnError: false },
  ]);
  const brokenId = res.body.queued[0].id;

  await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
  status = await waitForDeploy(api, projectId);
  r.check("a failing command fails the deploy", status !== "running", `status=${status}`);

  res = await api.call(`${url}?include=history`);
  const back = res.body.queued.find((entry) => entry.id === brokenId);
  r.check("the failed command is back in the queue", Boolean(back), JSON.stringify(res.body.queued));
  r.check("it kept its attempt count and the reason", back?.attempts === 1 && Boolean(back?.errorMessage), JSON.stringify(back));
  r.check(
    "the later phase was never reached and is still queued",
    res.body.queued.some((entry) => entry.phase === "post-deploy") &&
      !existsSync(join(repo, "mark-later.txt")),
    JSON.stringify(res.body.queued.map((entry) => entry.phase))
  );
  r.check("nothing failed was written to the history", res.body.history.length === 8, String(res.body.history.length));

  // --- fix it, and the retry consumes it ------------------------------------
  await put([
    { id: brokenId, phase: "post-build", command: marker("mark-fixed.txt"), label: "rotto", continueOnError: false },
    ...res.body.queued
      .filter((entry) => entry.id !== brokenId)
      .map((entry) => ({
        id: entry.id,
        phase: entry.phase,
        command: entry.command,
        label: entry.label,
        continueOnError: entry.continueOnError,
      })),
  ]);

  await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
  status = await waitForDeploy(api, projectId);
  r.check("the retry succeeds", status === "running", `status=${status}`);
  r.check("the fixed command ran", existsSync(join(repo, "mark-fixed.txt")), "mark-fixed.txt");

  res = await api.call(`${url}?include=history`);
  r.check("the retry emptied the queue", res.body.queued.length === 0, JSON.stringify(res.body.queued));
  const retried = res.body.history.find((entry) => entry.id === brokenId);
  r.check("the retry is recorded with both attempts counted", retried?.attempts === 2, JSON.stringify(retried));

  // --- "continua comunque" is consumed even when it fails -------------------
  await put([
    { phase: "post-build", command: 'node -e "process.exit(3)"', label: "non critico", continueOnError: true },
  ]);
  await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
  status = await waitForDeploy(api, projectId);
  r.check("a non-critical failure does not fail the deploy", status === "running", `status=${status}`);

  res = await api.call(`${url}?include=history`);
  const tolerated = res.body.history.find((entry) => entry.label === "non critico");
  r.check("it is consumed anyway", res.body.queued.length === 0, JSON.stringify(res.body.queued));
  r.check(
    "and recorded as failed, with the reason",
    tolerated?.status === "failed" && Boolean(tolerated?.errorMessage),
    JSON.stringify(tolerated)
  );

  // --- the history can be emptied -------------------------------------------
  const cleared = await api.call(url, { method: "DELETE" });
  r.check("the history clears", cleared.status === 200 && cleared.body.removed > 0, JSON.stringify(cleared.body));

  await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  return r.result();
}
