import { client, createReporter, docker, waitForDeploy, SETUP_TOKEN } from "../harness.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Docker Compose runtime.
 *
 * A repository that ships only a compose file used to be undeployable: the
 * builder claimed to detect one and then routed the project into `docker build`,
 * which failed with "Dockerfile not found".
 *
 * The stack here has two services so that "the stack is up" means more than one
 * container, and a published port so the health check has something to probe.
 */
export const meta = { name: "compose", needsDocker: true, drivers: ["sqlite"] };

const PORT = 3312;

export async function run({ base, dataDir }) {
  const r = createReporter("compose");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "compose-suite-pw" }),
  });

  const created = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Compose Suite" }),
  });
  const projectId = created.body.id;
  const slug = created.body.slug;

  const repo = join(dataDir, "repos", slug);
  mkdirSync(repo, { recursive: true });

  writeFileSync(join(repo, "docker-compose.yml"), `services:
  web:
    build: .
    ports:
      - "${PORT}:8080"
    environment:
      GREETING: \${GREETING:-unset}
    depends_on:
      - sidecar
  sidecar:
    image: alpine
    command: ["sh","-c","while true; do sleep 1; done"]
`);

  writeFileSync(join(repo, "Dockerfile"), `FROM node:22-alpine
WORKDIR /app
COPY server.js .
CMD ["node","server.js"]
`);

  writeFileSync(join(repo, "server.js"), `const http = require("http");
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ greeting: process.env.GREETING ?? null }));
}).listen(8080, "0.0.0.0");
`);

  // GREETING is interpolated by compose from the ambient environment, which is
  // how a compose file normally receives configuration.
  await api.call(`/api/projects/${projectId}/env`, {
    method: "PUT",
    body: JSON.stringify({ vars: [{ key: "GREETING", value: "from-compose" }] }),
  });

  const patched = await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({
      runtimeType: "compose",
      sourceType: "upload",
      port: PORT,
      builderConfig: {
        version: 1,
        healthcheck: { enabled: true, path: "/", expectStatus: [200], startPeriodSec: 3, timeoutSec: 90 },
      },
    }),
  });
  r.check("compose runtime accepted", patched.status === 200,
    `${patched.status} ${JSON.stringify(patched.body).slice(0, 140)}`);

  await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
  const status = await waitForDeploy(api, projectId);
  r.check("compose stack deployed and reached running", status === "running", `status=${status}`);

  if (status !== "running") {
    const history = await api.call(`/api/projects/${projectId}/logs`);
    const failed = (history.body ?? []).find((d) => d.status === "failed");
    if (failed) {
      const full = await api.call(`/api/deployments/${failed.id}?tail=25`);
      r.note("--- build log tail ---");
      for (const line of String(full.body?.build_log ?? "").trim().split("\n")) r.note(line);
    }
    await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
    return r.result();
  }

  const probe = await fetch(`http://127.0.0.1:${PORT}/`).then((x) => x.json());
  r.check("the compose service answers on its published port",
    probe.greeting === "from-compose", JSON.stringify(probe));

  const projectName = `runpanel-${slug}`;
  const running = docker("ps", "--filter", `label=com.docker.compose.project=${projectName}`, "--format", "{{.Names}}")
    .split("\n").filter(Boolean);
  r.note(`containers: ${running.join(", ")}`);
  r.check("both services of the stack are running", running.length === 2, `${running.length} container(s)`);

  // The stack has to share a network with the panel's services, or an
  // injected DATABASE_URL naming a service container never resolves. Compose
  // makes its own network; the override adds the project's on top.
  const projectNetwork = `runpanel-net-${slug}`;
  {
    const history = await api.call(`/api/projects/${projectId}/logs`);
    const latest = (history.body ?? []).find((d) => d.status === "running") ?? (history.body ?? [])[0];
    const full = latest ? await api.call(`/api/deployments/${latest.id}`) : null;
    const log = String(full?.body?.build_log ?? "");
    const networkLines = log.split("\n").filter((line) => /Rete del progetto|ATTENZIONE/.test(line));
    for (const line of networkLines) r.note(line);
    // Compose lists services alphabetically, so the order is not asserted.
    r.check(
      "the deploy log says which services were attached",
      networkLines.some(
        (line) => line.includes(`→ ${projectNetwork}`) && line.includes("web") && line.includes("sidecar")
      ),
      networkLines.join(" | ") || "(no network line in the log)"
    );
  }
  for (const name of running) {
    const networks = docker("inspect", name, "--format", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}");
    r.check(`${name} is on the project network`, networks.split(" ").includes(projectNetwork), networks);
  }
  r.check(
    "the user's compose file is left untouched",
    !readFileSync(join(repo, "docker-compose.yml"), "utf8").includes(projectNetwork)
  );

  // Status must reflect the whole stack, not just one container.
  const projectAfter = await api.call(`/api/projects/${projectId}/status`);
  r.check("status reports the stack as running", projectAfter.body.process?.running === true,
    JSON.stringify(projectAfter.body.process));

  // --- teardown ------------------------------------------------------------
  await api.call(`/api/projects/${projectId}`, { method: "DELETE" });

  const leftovers = docker("ps", "-a", "--filter", `label=com.docker.compose.project=${projectName}`, "--format", "{{.Names}}")
    .split("\n").filter(Boolean);
  r.check("deleting the project brings the whole stack down", leftovers.length === 0, leftovers.join(","));

  return r.result();
}
