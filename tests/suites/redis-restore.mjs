import { client, createReporter, docker, sleep, SETUP_TOKEN } from "../harness.mjs";

/**
 * Backing up a Redis that belongs to a project, and putting it back.
 *
 * The narrow case that was silently broken. `restoreRedis` rebuilt the volume
 * name from the service name with no project slug, so for a Redis inside a
 * project it aimed at `runpanel-redis-<nome>` while the data lived in
 * `runpanel-redis-<slug>-<nome>`. `docker run -v` **creates** a volume that
 * does not exist, so the dump went into a fresh empty one, the container
 * restarted on the real volume, and the restore reported success having changed
 * nothing. Nothing in the panel could have told you.
 *
 * A standalone Redis took the same path and happened to work, which is why no
 * test caught it: the name it derived was the right one. So the service here
 * belongs to a project on purpose — that is the whole assertion.
 */
export const meta = { name: "redis-restore", needsDocker: true, drivers: ["sqlite"] };

/** Outside every range Windows reserves for Hyper-V. */
const PORT = 47322;
const PASSWORD = "redis-restore-pw";

async function waitForRun(api, runId, deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { body } = await api.call(`/api/backups/runs/${runId}`);
    if (body?.status && body.status !== "running") return body;
    if (Date.now() > deadline) throw new Error(`Il backup ${runId} non è finito in tempo`);
    await sleep(500);
  }
}

async function waitForRestore(api, restoreId, deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { body } = await api.call(`/api/backups/restore/${restoreId}`);
    if (body?.status && body.status !== "running") return body;
    if (Date.now() > deadline) throw new Error("Il ripristino non è finito in tempo");
    await sleep(500);
  }
}

const redisCli = (container, ...args) =>
  docker("exec", "-e", `REDISCLI_AUTH=${PASSWORD}`, container, "redis-cli", "--no-auth-warning", ...args);

export async function run({ base }) {
  const r = createReporter("redis-restore");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      setup: true,
      setupToken: SETUP_TOKEN,
      password: "redis-restore-suite-pw",
    }),
  });

  const project = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Redis Restore Suite" }),
  });
  r.check("project created", project.status === 201, JSON.stringify(project.body));
  const projectId = project.body?.id;

  const service = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({
      name: "cache",
      type: "redis",
      version: "7",
      port: PORT,
      projectId,
      credentials: { password: PASSWORD },
    }),
  });
  r.check("redis provisioned inside the project", service.status === 201, JSON.stringify(service.body));
  if (service.status !== 201) return r.result();

  const serviceId = service.body.id;
  const container = service.body.container_name;

  // The name the old code would have derived, versus the one that exists. If
  // these ever coincide the regression this suite guards stops being testable.
  r.check(
    "the container is project-scoped, so its volume name carries the slug",
    container.includes("redis-restore-suite"),
    container
  );

  await sleep(1500);
  redisCli(container, "SET", "prima", "valore-originale");
  r.check(
    "a key is written",
    redisCli(container, "GET", "prima").includes("valore-originale"),
    redisCli(container, "GET", "prima")
  );

  // --- back it up -----------------------------------------------------------
  const destinations = await api.call("/api/backups/destinations");
  const destinationId = destinations.body?.destinations?.[0]?.id;

  const policy = await api.call("/api/backups/policies", {
    method: "POST",
    body: JSON.stringify({
      name: "Redis della suite",
      cron: "0 3 * * *",
      timezone: "Europe/Rome",
      destinationId,
      targets: [{ kind: "service", id: serviceId }],
      retentionCount: 2,
    }),
  });
  r.check("policy created", policy.status === 201, JSON.stringify(policy.body));

  const started = await api.call(`/api/backups/policies/${policy.body.id}/run`, { method: "POST" });
  r.check("the run is accepted", started.status === 202, JSON.stringify(started.body));

  const finished = await waitForRun(api, started.body.runId);
  r.check("the backup succeeds", finished.status === "success", JSON.stringify(finished.errorMessage));

  const artifact = finished.artifacts?.find((entry) => entry.refId === serviceId);
  r.check("the redis was captured", artifact?.status === "ok", JSON.stringify(finished.artifacts));
  if (!artifact) return r.result();

  // --- change the data, then put the backup back ----------------------------
  redisCli(container, "SET", "prima", "valore-cambiato");
  redisCli(container, "SET", "dopo", "chiave-nuova");
  r.check(
    "the data is different now",
    redisCli(container, "GET", "prima").includes("valore-cambiato"),
    redisCli(container, "GET", "prima")
  );

  const restoreStarted = await api.call("/api/backups/restore", {
    method: "POST",
    // The confirmation is the name of what is about to be overwritten, so it
    // cannot be typed by muscle memory on the wrong service.
    body: JSON.stringify({
      runId: finished.id,
      confirm: "cache",
      targets: [{ artifactId: artifact.id, action: "restore" }],
    }),
  });
  r.check("the restore is accepted", restoreStarted.status === 202, JSON.stringify(restoreStarted.body));
  if (restoreStarted.status !== 202) return r.result();

  const restore = await waitForRestore(api, restoreStarted.body.restoreId);
  r.check("the restore reports success", restore.status === "success", JSON.stringify(restore.errorMessage));

  // Redis loads the RDB at boot, so the container has to come back before the
  // answer means anything.
  await sleep(3000);

  // **The assertion this suite exists for.** With the old code the restore
  // wrote into a volume nobody was using, so both of these would still show the
  // post-backup values and the run would still say "success".
  r.check(
    "the restored value is the one from the backup",
    redisCli(container, "GET", "prima").includes("valore-originale"),
    redisCli(container, "GET", "prima")
  );
  r.check(
    "and the key written after the backup is gone",
    !redisCli(container, "GET", "dopo").includes("chiave-nuova"),
    redisCli(container, "GET", "dopo")
  );

  // The empty volume the old code would have created must not exist either.
  r.check(
    "no stray volume was created under the unscoped name",
    !docker("volume", "ls", "--format", "{{.Name}}").split("\n").includes("runpanel-redis-cache"),
    docker("volume", "ls", "--format", "{{.Name}}")
  );

  await api.call(`/api/services/${serviceId}?deleteData=true`, { method: "DELETE" });
  await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  return r.result();
}
