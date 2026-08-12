import { client, createReporter, docker, waitForDeploy, SETUP_TOKEN } from "../harness.mjs";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The deploy contract, against a real Docker daemon.
 *
 * The project under test reproduces the constraints that actually break panels:
 * a Dockerfile that FAILS when a build arg is missing, an app that reads a
 * mounted .env rather than process.env, a release command that must run between
 * build and start, and a health endpoint that is not "/".
 *
 * No RunPanel code knows anything about this project. If it needed a special
 * case to deploy, the contract would be incomplete.
 */
export const meta = { name: "deploy-contract", needsDocker: true, drivers: ["sqlite"] };

const PORT = 3311;

export async function run({ base, dataDir }) {
  const r = createReporter("deploy-contract");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "contract-suite-pw" }),
  });

  const created = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Contract Suite" }),
  });
  const projectId = created.body.id;
  const slug = created.body.slug;

  const shared = join(tmpdir(), `runpanel-contract-${Date.now()}`);
  rmSync(shared, { recursive: true, force: true });
  mkdirSync(shared, { recursive: true });

  // The checkout lives where an "upload" source would have put it.
  const repo = join(dataDir, "repos", slug);
  mkdirSync(repo, { recursive: true });

  writeFileSync(join(repo, "Dockerfile"), `FROM node:22-alpine
ARG NEXT_PUBLIC_BASE_URL
RUN test -n "$NEXT_PUBLIC_BASE_URL" || (echo "FATAL: NEXT_PUBLIC_BASE_URL build arg is required" && exit 1)
RUN echo "$NEXT_PUBLIC_BASE_URL" > /baked-url
WORKDIR /app
COPY server.js .
CMD ["node","server.js"]
`);

  writeFileSync(join(repo, "server.js"), `const http = require("http");
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; } };
http.createServer((req, res) => {
  if (req.url !== "/healthz") { res.writeHead(404); res.end("not here"); return; }
  const envFile = read("/app/.env");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    bakedUrl: read("/baked-url"),
    envFilePresent: envFile !== null,
    envFileHasSecret: (envFile || "").includes("SECRET_TOKEN"),
    quoted: (envFile || "").match(/QUOTED_VALUE=(.*)/)?.[1] ?? null,
    releaseMarker: read("/shared/released"),
  }));
}).listen(${PORT}, "0.0.0.0");
`);

  await api.call(`/api/projects/${projectId}/env`, {
    method: "PUT",
    body: JSON.stringify({
      vars: [
        { key: "NEXT_PUBLIC_BASE_URL", value: "https://contract.example" },
        { key: "SECRET_TOKEN", value: "s3cr3t" },
        { key: "QUOTED_VALUE", value: 'has spaces and "quotes"' },
      ],
    }),
  });

  const patched = await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({
      runtimeType: "docker",
      sourceType: "upload",
      port: PORT,
      builderConfig: {
        version: 1,
        commands: { release: "echo released-ok > /shared/released" },
        envFile: { enabled: true, path: "/app/.env" },
        docker: { mounts: [`${shared.replace(/\\/g, "/")}:/shared`] },
        healthcheck: { enabled: true, path: "/healthz", expectStatus: [200], startPeriodSec: 2, timeoutSec: 60 },
      },
    }),
  });
  r.check("contract accepted", patched.status === 200, `${patched.status} ${JSON.stringify(patched.body).slice(0, 160)}`);

  const deploy = await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
  r.check("deploy accepted", deploy.status === 202, String(deploy.status));

  const status = await waitForDeploy(api, projectId);
  r.check("deploy reached running", status === "running", `status=${status}`);

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

  const probe = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((x) => x.json());
  r.note(`app reports: ${JSON.stringify(probe)}`);

  r.check("build arg reached the Dockerfile", probe.bakedUrl === "https://contract.example", String(probe.bakedUrl));
  r.check("env file mounted into the container", probe.envFilePresent === true);
  r.check("env file carries the runtime secret", probe.envFileHasSecret === true);
  r.check(
    "a quoted value survives .env serialisation",
    probe.quoted === String.raw`"has spaces and \"quotes\""`,
    String(probe.quoted)
  );
  r.check("release command ran before start", probe.releaseMarker === "released-ok", String(probe.releaseMarker));

  const rootStatus = await fetch(`http://127.0.0.1:${PORT}/`).then((x) => x.status);
  r.check("root 404s, so health passed via the configured path", rootStatus === 404, String(rootStatus));

  const inspect = docker("inspect", `runpanel-${slug}`, "--format",
    "{{.HostConfig.RestartPolicy.Name}}|{{range .HostConfig.Binds}}{{.}} {{end}}");
  r.check("restart policy applied", inspect.startsWith("unless-stopped"), inspect);
  r.check("mounts applied", inspect.includes("/shared"), inspect);

  // Removing the mandatory build arg must FAIL the deploy, not ship a wrong value.
  await api.call(`/api/projects/${projectId}/env`, {
    method: "PUT",
    body: JSON.stringify({ vars: [{ key: "SECRET_TOKEN", value: "s3cr3t" }] }),
  });
  await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
  const second = await waitForDeploy(api, projectId);
  r.check("a missing build arg fails the deploy", second === "error" || second === "stopped", `status=${second}`);

  await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  rmSync(shared, { recursive: true, force: true });
  return r.result();
}
