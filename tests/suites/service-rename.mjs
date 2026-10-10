import { client, createReporter, docker, sleep, waitForDeploy, SETUP_TOKEN } from "../harness.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Renaming a service that already exists, against a real daemon.
 *
 * The name changes at once, in the panel. The container follows it at the next
 * deploy of its project — the moment the app restarts anyway and is handed the
 * new host — and the data never moves: the volume keeps the name it was
 * created with, because Docker cannot rename one and a re-derived name would
 * start the database on an empty volume.
 *
 * Compose, because it is the runtime whose app reaches the service by
 * container name on the project network, which is exactly what a rename
 * changes.
 */
export const meta = { name: "service-rename", needsDocker: true, drivers: ["sqlite"] };

const PORT = 47341;
const PASSWORD = "rename-suite-pw";

async function buildLog(api, projectId) {
  const history = await api.call(`/api/projects/${projectId}/logs`);
  const latest = (history.body ?? [])[0];
  if (!latest) return "";
  const full = await api.call(`/api/deployments/${latest.id}`);
  return String(full.body?.build_log ?? "");
}

export async function run({ base, dataDir }) {
  const r = createReporter("service-rename");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "service-rename-suite-pw" }),
  });

  const project = await api.call("/api/projects", { method: "POST", body: JSON.stringify({ name: "Rename Suite" }) });
  const projectId = project.body.id;
  const slug = project.body.slug;

  const repo = join(dataDir, "repos", slug);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "docker-compose.yml"), `services:
  app:
    image: alpine
    command: ["sh","-c","echo \\"$$REDIS_URL\\" > /tmp/url; while true; do sleep 1; done"]
    environment:
      REDIS_URL: \${REDIS_URL:-unset}
`);
  await api.call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({
      runtimeType: "compose",
      sourceType: "upload",
      builderConfig: { version: 1, healthcheck: { enabled: false } },
    }),
  });

  const created = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({ name: "cache", type: "redis", version: "7", port: PORT, projectId, credentials: { email: "owner@runpanel.test", password: PASSWORD } }),
  });
  r.check("a redis is created inside the project", created.status === 201, JSON.stringify(created.body).slice(0, 160));
  if (created.status !== 201) return r.result();
  const serviceId = created.body.id;
  const original = created.body.container_name;
  const volume = `runpanel-redis-${slug}-cache`;
  let otherId = null;
  let secondProjectId = null;

  const redis = (container, ...args) =>
    docker("exec", "-e", `REDISCLI_AUTH=${PASSWORD}`, container, "redis-cli", "--no-auth-warning", ...args);

  try {
    await sleep(1500);
    redis(original, "SET", "chiave", "valore-prima-del-rename");

    // --- the name changes at once, the container does not ----------------------------
    const renamed = await api.call(`/api/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "Cache Principale" }),
    });
    r.check("a service can be renamed", renamed.status === 200, `${renamed.status} ${JSON.stringify(renamed.body).slice(0, 120)}`);

    const detail = (await api.call(`/api/services/${serviceId}`)).body;
    const target = `runpanel-svc-${slug}-cache-principale`;
    r.check("the panel shows the new name", detail.displayName === "Cache Principale", detail.displayName);
    r.check("the technical name stays", detail.name === "cache", detail.name);
    r.check("the container keeps its name until the project deploys", detail.containerName === original, detail.containerName);
    r.check("and the page says what it will become", detail.pendingContainerName === target, String(detail.pendingContainerName));
    r.check("nothing was restarted yet", docker("inspect", original, "--format", "{{.State.Running}}") === "true");

    const listed = (await api.call("/api/services")).body.find((row) => row.id === serviceId);
    r.check("lists carry the name to show", listed?.display_name === "Cache Principale", JSON.stringify(listed).slice(0, 120));

    const tooLong = await api.call(`/api/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "x".repeat(61) }),
    });
    r.check("a name past the limit is refused", tooLong.status === 400, String(tooLong.status));

    // --- the deploy moves the container, not the data ----------------------------------
    await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
    const status = await waitForDeploy(api, projectId);
    r.check("the project deploys", status === "running", `status=${status}`);

    const after = (await api.call(`/api/services/${serviceId}`)).body;
    r.check("the deploy gave the container the new name", after.containerName === target, after.containerName);
    r.check("and nothing is pending any more", after.pendingContainerName === null, String(after.pendingContainerName));
    r.check("the new container is running", docker("inspect", target, "--format", "{{.State.Running}}") === "true");
    r.check("the old one is gone", docker("ps", "-a", "--filter", `name=^/${original}$`, "--format", "{{.Names}}") === "");
    r.check(
      "it mounts the same volume it always had",
      docker("inspect", target, "--format", "{{range .Mounts}}{{.Name}} {{end}}").split(" ").includes(volume),
      docker("inspect", target, "--format", "{{range .Mounts}}{{.Name}} {{end}}")
    );
    await sleep(1500);
    r.check(
      "and the data is there",
      redis(target, "GET", "chiave") === "valore-prima-del-rename",
      redis(target, "GET", "chiave")
    );

    const app = docker("ps", "-q", "--filter", `label=com.docker.compose.project=runpanel-${slug}`, "--filter", "label=com.docker.compose.service=app");
    const url = app ? docker("exec", app, "cat", "/tmp/url") : "";
    r.check("the app is handed the new host", url.includes(`@${target}:6379`), url.replace(PASSWORD, "***"));

    const networks = docker("inspect", target, "--format", "{{json .NetworkSettings.Networks}}");
    r.check("the old name stays as an alias on the project network", networks.includes(`"${original}"`), networks.slice(0, 300));
    const resolved = app ? docker("exec", app, "sh", "-c", `nslookup ${original} 2>/dev/null | tail -n +3`) : "";
    r.check("and still resolves from the app", /Address/.test(resolved), resolved || "(nothing)");

    const log = await buildLog(api, projectId);
    r.check(
      "the deploy log says what it renamed, and where the data stays",
      log.includes(`il container ${original} diventa ${target}`) && log.includes(volume),
      log.split("\n").filter((line) => line.includes("Servizio")).join(" | ")
    );

    // --- a name another container already has is refused -------------------------------
    const other = await api.call("/api/services", {
      method: "POST",
      body: JSON.stringify({ name: "other", type: "redis", version: "7", port: PORT + 1, projectId, credentials: { email: "owner@runpanel.test", password: PASSWORD } }),
    });
    otherId = other.body?.id ?? null;
    await api.call(`/api/services/${serviceId}`, { method: "PATCH", body: JSON.stringify({ displayName: "Other" }) });
    await api.call(`/api/projects/${projectId}/deploy`, { method: "POST", body: "{}" });
    r.check("the project still deploys", (await waitForDeploy(api, projectId)) === "running");
    const blocked = (await api.call(`/api/services/${serviceId}`)).body;
    r.check("a name taken by another service is not taken from it", blocked.containerName === target, blocked.containerName);
    r.check(
      "and the deploy log says why",
      (await buildLog(api, projectId)).includes("il container resta"),
      (await buildLog(api, projectId)).split("\n").filter((line) => line.includes("Servizio")).join(" | ")
    );
    r.check("the other service is untouched", docker("inspect", other.body?.container_name ?? "", "--format", "{{.State.Running}}") === "true");

    // --- moved to another project, then recreated: still on its own data ---------------
    // The same trap from the other side. The volume name is derived from the
    // project slug too, so a recreate after a move used to start the database
    // on a fresh, empty volume while its data sat in the old one.
    const second = await api.call("/api/projects", { method: "POST", body: JSON.stringify({ name: "Rename Suite Two" }) });
    secondProjectId = second.body?.id ?? null;
    const moved = await api.call(`/api/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId: secondProjectId }),
    });
    r.check("the service moves to another project", moved.status === 200, String(moved.status));
    const recreated = await api.call(`/api/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ access: { mode: "restricted", allow: [] } }),
    });
    r.check("and is recreated by an access change", recreated.status === 200, `${recreated.status} ${JSON.stringify(recreated.body).slice(0, 120)}`);
    const current = (await api.call(`/api/services/${serviceId}`)).body.containerName;
    await sleep(1500);
    r.check(
      "the recreated container is on the volume it had, not a new one",
      docker("inspect", current, "--format", "{{range .Mounts}}{{.Name}} {{end}}").split(" ").includes(volume),
      docker("inspect", current, "--format", "{{range .Mounts}}{{.Name}} {{end}}")
    );
    r.check("with its data", redis(current, "GET", "chiave") === "valore-prima-del-rename", redis(current, "GET", "chiave"));
    r.check(
      "and no empty volume was created under the new project's name",
      !docker("volume", "ls", "--format", "{{.Name}}").split("\n").includes(`runpanel-redis-${second.body?.slug}-cache`)
    );
    await api.call(`/api/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ access: { mode: "open", allow: [] } }),
    });
  } finally {
    for (const id of [serviceId, otherId].filter(Boolean)) {
      await api.call(`/api/services/${id}?deleteData=true`, { method: "DELETE" });
    }
    for (const id of [projectId, secondProjectId].filter(Boolean)) {
      await api.call(`/api/projects/${id}`, { method: "DELETE" });
    }
  }

  return r.result();
}
