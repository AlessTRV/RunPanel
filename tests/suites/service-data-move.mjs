import { client, createReporter, docker, sleep, SETUP_TOKEN } from "../harness.mjs";

/**
 * Moving a service's data to a directory the operator chose.
 *
 * The dangerous instant is recreating the container on a directory that may or
 * may not hold the database, and the assertions here are the guardrails around
 * it: that the data arrives, that the old copy is still there afterwards, that
 * a destination which already holds something is refused until somebody says
 * otherwise, and that a system directory is refused outright.
 *
 * Redis, because it is the one engine whose image is already on a RunPanel host
 * and whose contents can be checked in one command. The mechanism is the same
 * for all four — the copy, the recreate and the inventory check do not know
 * which engine they are looking at.
 */
export const meta = { name: "service-data-move", needsDocker: true, drivers: ["sqlite"] };

/** Outside every range Windows reserves for Hyper-V. */
const PORT = 47323;
const PASSWORD = "move-suite-pw";

/**
 * Inside the daemon's filesystem, not the panel's — which is the whole point of
 * doing every step through a throwaway container. On Docker Desktop that is the
 * Linux VM; on a Linux host it is the host.
 */
const DEST = "/var/tmp/runpanel-move-suite/data";
const SECOND = "/var/tmp/runpanel-move-suite/altra";

const redisCli = (container, ...args) =>
  docker("exec", "-e", `REDISCLI_AUTH=${PASSWORD}`, container, "redis-cli", "--no-auth-warning", ...args);

async function waitForPhase(api, serviceId, phases, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api.call(`/api/services/${serviceId}`);
    const phase = body?.dataMove?.phase;
    if (phase && phases.includes(phase)) return body;
    if (Date.now() > deadline) throw new Error(`Lo spostamento è rimasto su "${phase}"`);
    await sleep(1000);
  }
}

export async function run({ base }) {
  const r = createReporter("service-data-move");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "move-suite-password" }),
  });

  // A clean slate inside the daemon, using an image that is certainly present.
  docker("run", "--rm", "-v", "/var/tmp:/host", "redis:7", "sh", "-c", "rm -rf /host/runpanel-move-suite");

  const project = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Move Suite" }),
  });
  const projectId = project.body?.id;

  const created = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({
      name: "movecache",
      type: "redis",
      version: "7",
      port: PORT,
      projectId,
      credentials: { password: PASSWORD },
    }),
  });
  r.check("redis provisioned", created.status === 201, JSON.stringify(created.body));
  if (created.status !== 201) return r.result();

  const serviceId = created.body.id;
  const container = created.body.container_name;
  const move = (body) =>
    api.call(`/api/services/${serviceId}/data-path`, { method: "POST", body: JSON.stringify(body) });

  await sleep(1500);
  redisCli(container, "SET", "chiave", "valore-da-spostare");
  // Deterministic rather than relying on the shutdown snapshot.
  redisCli(container, "SAVE");

  let detail = await api.call(`/api/services/${serviceId}`);
  r.check(
    "it starts on the managed volume",
    detail.body.dataPath === null && detail.body.dataDefault?.source?.startsWith("runpanel-redis-"),
    JSON.stringify({ path: detail.body.dataPath, def: detail.body.dataDefault })
  );

  // --- what may never be a data directory -----------------------------------
  for (const [what, path] of [
    ["a relative path", "mnt/dati"],
    ["a traversal", "/mnt/../etc"],
    ["a single level", "/mnt"],
    ["a system directory", "/etc/postgres"],
    ["docker's own state", "/var/lib/docker/volumes/x"],
    ["a windows path", "C:\\dati"],
  ]) {
    const res = await move({ path });
    r.check(`${what} is refused`, res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
  }

  // --- the move -------------------------------------------------------------
  let res = await move({ path: DEST });
  r.check("the move is accepted", res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);

  detail = await waitForPhase(api, serviceId, ["done", "failed"]);
  r.check(
    "it completes",
    detail.dataMove.phase === "done",
    JSON.stringify({ phase: detail.dataMove.phase, error: detail.dataMove.error })
  );
  r.check("the service now records the new path", detail.dataPath === DEST, String(detail.dataPath));

  await sleep(2000);
  r.check(
    "the data arrived",
    redisCli(container, "GET", "chiave").includes("valore-da-spostare"),
    redisCli(container, "GET", "chiave")
  );
  r.check("the service is running again", detail.status === "running", detail.status);

  // The old copy is deliberately still there: deleting it is a separate
  // decision the operator makes after checking this one.
  r.check(
    "the previous location is remembered and untouched",
    detail.dataMove.leftBehind?.kind === "volume" &&
      docker("volume", "ls", "--format", "{{.Name}}").includes(detail.dataMove.leftBehind.ref),
    JSON.stringify(detail.dataMove.leftBehind)
  );

  // --- a destination that already holds something ---------------------------
  res = await move({ path: SECOND });
  r.check("a second move to an empty directory is accepted", res.status === 202, String(res.status));
  detail = await waitForPhase(api, serviceId, ["done", "failed"]);
  r.check("and completes", detail.dataMove.phase === "done", JSON.stringify(detail.dataMove.error));

  // DEST still holds the copy from the first move, so pointing back at it must
  // stop rather than write over a database.
  res = await move({ path: DEST });
  r.check(
    "a non-empty destination is refused, with a code the UI can act on",
    res.status === 409 && res.body.code === "destination-not-empty",
    `${res.status} ${JSON.stringify(res.body)}`
  );
  r.check("and it says what it found", Array.isArray(res.body.entries) && res.body.entries.length > 0,
    JSON.stringify(res.body.entries));

  res = await move({ path: DEST, adoptExisting: true });
  r.check("adopting it explicitly is allowed", res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);
  detail = await waitForPhase(api, serviceId, ["done", "failed"]);
  r.check("the adopted move completes", detail.dataMove.phase === "done", JSON.stringify(detail.dataMove.error));
  r.check("and it copied nothing", detail.dataMove.adopted === true, String(detail.dataMove.adopted));

  await sleep(2000);
  r.check(
    "the adopted data is the data",
    redisCli(container, "GET", "chiave").includes("valore-da-spostare"),
    redisCli(container, "GET", "chiave")
  );

  // --- deleting what was left behind ----------------------------------------
  //
  // Asymmetric on purpose: the previous location is now a host directory, and
  // the panel hands back a command instead of running `rm -rf` on a path an
  // operator typed.
  const removed = await api.call(`/api/services/${serviceId}/data-path`, { method: "DELETE" });
  r.check(
    "a host directory is not deleted by the panel",
    removed.status === 200 && typeof removed.body.command === "string",
    JSON.stringify(removed.body)
  );

  // --- and back to the managed volume ---------------------------------------
  res = await move({ path: null });
  r.check("going back to the default volume is accepted", res.status === 202, String(res.status));
  detail = await waitForPhase(api, serviceId, ["done", "failed"]);
  r.check("it completes", detail.dataMove.phase === "done", JSON.stringify(detail.dataMove.error));
  r.check("and the path is cleared", detail.dataPath === null, String(detail.dataPath));

  await sleep(2000);
  r.check(
    "the data came back with it",
    redisCli(container, "GET", "chiave").includes("valore-da-spostare"),
    redisCli(container, "GET", "chiave")
  );

  // --- a move that cannot work must undo itself -----------------------------
  //
  // The safety the whole design rests on. A directory holding a corrupt RDB is
  // a destination Redis will refuse to start on, and "the container was
  // created" says nothing about that — only asking the engine what it holds
  // does. The panel has to notice, put the container back where it was, and
  // leave the data intact.
  const BROKEN = "/var/tmp/runpanel-move-suite/rotta";
  docker(
    "run", "--rm", "-v", "/var/tmp:/host", "redis:7",
    "sh", "-c",
    `mkdir -p /host/runpanel-move-suite/rotta && printf 'REDIS0011rovinato' > /host/runpanel-move-suite/rotta/dump.rdb`
  );

  res = await move({ path: BROKEN, adoptExisting: true });
  r.check("the doomed move is accepted", res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);

  detail = await waitForPhase(api, serviceId, ["done", "failed"]);
  r.check(
    "it fails rather than reporting success",
    detail.dataMove.phase === "failed",
    JSON.stringify(detail.dataMove)
  );
  r.check("it says why", Boolean(detail.dataMove.error), String(detail.dataMove.error));
  r.check("it rolled back by itself", detail.dataMove.rolledBack === true, String(detail.dataMove.rolledBack));
  r.check(
    "and the recorded path is the one it came from",
    detail.dataPath === null,
    String(detail.dataPath)
  );

  await sleep(3000);
  r.check(
    "the data is still there",
    redisCli(container, "GET", "chiave").includes("valore-da-spostare"),
    redisCli(container, "GET", "chiave")
  );

  await api.call(`/api/services/${serviceId}?deleteData=true`, { method: "DELETE" });
  await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  docker("run", "--rm", "-v", "/var/tmp:/host", "redis:7", "sh", "-c", "rm -rf /host/runpanel-move-suite");
  return r.result();
}
