import { client, createReporter, docker, sleep, SETUP_TOKEN } from "../harness.mjs";

/**
 * Publishing a service's folders on the host.
 *
 * The assertion that matters is the seeding one. A bind mount **substitutes**:
 * Docker copies nothing into it, and whatever was at that path inside the
 * container is covered rather than carried out. So a bind switched on over a
 * folder with content shows an empty folder unless the panel copies it out
 * first — and "I add it and see what is inside" is the whole point of the
 * feature. Every other check here guards a way of getting that wrong.
 *
 * Redis, because its image is already on a RunPanel host and its contents can
 * be read in one command. The machinery does not know which engine it is
 * looking at.
 */
export const meta = { name: "service-mounts", needsDocker: true, drivers: ["sqlite"] };

/** Outside every range Windows reserves for Hyper-V. */
const PORT = 47330;
const PASSWORD = "mount-suite-pw";

const ROOT = "/var/tmp/runpanel-mount-suite";
const EXTRA = `${ROOT}/config`;
const DATA = `${ROOT}/data`;

const redisCli = (container, ...args) =>
  docker("exec", "-e", `REDISCLI_AUTH=${PASSWORD}`, container, "redis-cli", "--no-auth-warning", ...args);

/** Read a host directory through a throwaway container: the daemon's namespace is the real one. */
const hostLs = (dir) =>
  docker("run", "--rm", "-v", `${dir}:/x`, "redis:7", "sh", "-c", "ls -A /x 2>/dev/null");

const scrub = () =>
  docker("run", "--rm", "-v", "/var/tmp:/host", "redis:7", "sh", "-c", "rm -rf /host/runpanel-mount-suite");

async function waitForPhase(api, serviceId, phases, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api.call(`/api/services/${serviceId}`);
    const phase = body?.mountApply?.phase;
    if (phase && phases.includes(phase)) return body;
    if (Date.now() > deadline) throw new Error(`L'applicazione è rimasta su "${phase}"`);
    await sleep(1000);
  }
}

export async function run({ base }) {
  const r = createReporter("service-mounts");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "mount-suite-password" }),
  });

  scrub();

  const created = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({
      name: "mountcache",
      type: "redis",
      version: "7",
      port: PORT,
      credentials: { password: PASSWORD },
    }),
  });
  r.check("redis provisioned", created.status === 201, JSON.stringify(created.body));
  if (created.status !== 201) return r.result();

  const serviceId = created.body.id;
  const container = created.body.container_name;
  const put = (body) =>
    api.call(`/api/services/${serviceId}/mounts`, { method: "PUT", body: JSON.stringify(body) });

  await sleep(1500);
  redisCli(container, "SET", "chiave", "valore-di-prova");
  redisCli(container, "SAVE");

  let detail = await api.call(`/api/services/${serviceId}`);
  r.check("it starts with no binds", Array.isArray(detail.body.mounts) && detail.body.mounts.length === 0,
    JSON.stringify(detail.body.mounts));

  // --- what may never be bound ----------------------------------------------
  for (const [what, mount] of [
    ["a relative host path", { source: "mnt/dati", target: "/etc/x" }],
    ["a traversal", { source: "/mnt/../etc", target: "/etc/x" }],
    ["a single-level host path", { source: "/mnt", target: "/etc/x" }],
    ["a system directory", { source: "/etc/redis", target: "/etc/x" }],
    ["docker's own state", { source: "/var/lib/docker/volumes/x", target: "/etc/x" }],
    ["a windows host path", { source: "C:\\dati", target: "/etc/x" }],
    ["the container root", { source: "/mnt/dati/x", target: "/" }],
    ["a kernel filesystem", { source: "/mnt/dati/x", target: "/proc/self" }],
    ["a relative container path", { source: "/mnt/dati/x", target: "etc/x" }],
  ]) {
    const res = await put({ mounts: [{ id: "m1", enabled: true, readOnly: false, ...mount }] });
    r.check(`${what} is refused`, res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
  }

  const dup = await put({
    mounts: [
      { id: "a", source: "/mnt/dati/uno", target: "/etc/redis-extra", enabled: true, readOnly: false },
      { id: "b", source: "/mnt/dati/due", target: "/etc/redis-extra", enabled: true, readOnly: false },
    ],
  });
  r.check("two binds on one container path are refused", dup.status === 400,
    `${dup.status} ${JSON.stringify(dup.body)}`);

  // --- the seeding, which is the whole feature ------------------------------
  //
  // `/etc` in the redis image holds real files. Binding an empty host directory
  // over it must show them on the host, not hide them from the container.
  const inContainer = docker("exec", container, "sh", "-c", "ls -A /etc | head -n 40");
  r.check("the container path has content to begin with", inContainer.trim().length > 0, inContainer);

  let res = await put({
    mounts: [{ id: "cfg", source: EXTRA, target: "/etc", enabled: true, readOnly: false }],
  });
  r.check("the bind is accepted", res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);

  detail = await waitForPhase(api, serviceId, ["done", "failed"]);
  r.check("it completes", detail.mountApply.phase === "done", JSON.stringify(detail.mountApply));

  const onHost = hostLs(EXTRA);
  r.check(
    "the content appeared on the host",
    onHost.trim().length > 0,
    onHost.slice(0, 200)
  );
  r.check(
    "and it is the container's content, not something else",
    inContainer.split("\n").filter(Boolean).slice(0, 5).every((name) => onHost.includes(name.trim())),
    `host: ${onHost.slice(0, 200)}`
  );
  r.check(
    "the container still sees it too",
    docker("exec", container, "sh", "-c", "ls -A /etc | head -n 5").trim().length > 0
  );

  // Live in both directions: it is the same directory, so nothing is synced.
  docker("run", "--rm", "-v", `${EXTRA}:/x`, "redis:7", "sh", "-c", "echo ciao > /x/runpanel-prova");
  r.check(
    "a file written on the host appears inside without a restart",
    docker("exec", container, "cat", "/etc/runpanel-prova").includes("ciao"),
    docker("exec", container, "sh", "-c", "ls -A /etc | tail -n 3")
  );

  // --- switching one off -----------------------------------------------------
  res = await put({
    mounts: [{ id: "cfg", source: EXTRA, target: "/etc", enabled: false, readOnly: false }],
  });
  r.check("it can be switched off", res.status === 202, String(res.status));
  detail = await waitForPhase(api, serviceId, ["done", "failed"]);
  r.check("switching off completes", detail.mountApply.phase === "done", JSON.stringify(detail.mountApply.error));

  r.check(
    "the container goes back to its own content",
    !docker("exec", container, "sh", "-c", "ls -A /etc").includes("runpanel-prova"),
    docker("exec", container, "sh", "-c", "ls -A /etc | tail -n 3")
  );
  r.check("and the host folder keeps its files", hostLs(EXTRA).includes("runpanel-prova"), hostLs(EXTRA));

  // --- a destination that already holds something ---------------------------
  res = await put({
    mounts: [{ id: "cfg", source: EXTRA, target: "/etc", enabled: true, readOnly: false }],
  });
  r.check(
    "turning it back on over a non-empty folder is refused, with a code",
    res.status === 409 && res.body.code === "destination-not-empty",
    `${res.status} ${JSON.stringify(res.body)}`
  );
  r.check("and it names the row", res.body.mountId === "cfg", String(res.body.mountId));

  res = await put({
    mounts: [{ id: "cfg", source: EXTRA, target: "/etc", enabled: true, readOnly: false }],
    adopt: ["cfg"],
  });
  r.check("adopting it explicitly is allowed", res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);
  detail = await waitForPhase(api, serviceId, ["done", "failed"]);
  r.check("the adopted bind completes", detail.mountApply.phase === "done", JSON.stringify(detail.mountApply.error));
  r.check(
    "and the file written earlier is what the container sees",
    docker("exec", container, "cat", "/etc/runpanel-prova").includes("ciao")
  );

  // --- the data directory, which takes the careful path ---------------------
  res = await put({
    mounts: [
      { id: "cfg", source: EXTRA, target: "/etc", enabled: true, readOnly: false },
      { id: "dat", source: DATA, target: "/data", enabled: true, readOnly: false },
    ],
    adopt: ["cfg"],
  });
  r.check("a bind on the data directory is accepted", res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);

  detail = await waitForPhase(api, serviceId, ["done", "failed"]);
  r.check(
    "it completes, having verified the contents",
    detail.mountApply.phase === "done",
    JSON.stringify(detail.mountApply)
  );

  await sleep(2000);
  r.check(
    "the key survived the move",
    redisCli(container, "GET", "chiave").includes("valore-di-prova"),
    redisCli(container, "GET", "chiave")
  );
  r.check(
    "and Docker really is mounting the host directory",
    (detail.containerMounts ?? []).some((m) => m.source === DATA && m.target === "/data"),
    JSON.stringify(detail.containerMounts)
  );

  // --- giving the data bind back is not an ordinary edit --------------------
  //
  // The engine would return to the volume it used before, which is frozen at the
  // moment the bind was made. Everything written since stays in the host folder
  // and the service comes up on an older database, working perfectly. Nothing
  // downstream notices, which is exactly why it has to be refused until it is
  // said out loud.
  redisCli(container, "SET", "dopo-lo-spostamento", "solo-nel-bind");
  redisCli(container, "SAVE");

  res = await put({
    mounts: [
      { id: "cfg", source: EXTRA, target: "/etc", enabled: true, readOnly: false },
      { id: "dat", source: DATA, target: "/data", enabled: false, readOnly: false },
    ],
    adopt: ["cfg"],
  });
  r.check(
    "switching the data bind off is refused, with a code",
    res.status === 409 && res.body.code === "data-mount-removed",
    `${res.status} ${JSON.stringify(res.body)}`
  );
  r.check("and it names the row", res.body.mountId === "dat", String(res.body.mountId));

  r.check(
    "the refusal changed nothing",
    redisCli(container, "GET", "dopo-lo-spostamento").includes("solo-nel-bind"),
    redisCli(container, "GET", "dopo-lo-spostamento")
  );

  // Read-only on the data directory is a service that starts and cannot write.
  res = await put({
    mounts: [
      { id: "cfg", source: EXTRA, target: "/etc", enabled: true, readOnly: false },
      { id: "dat", source: DATA, target: "/data", enabled: true, readOnly: true },
    ],
    adopt: ["cfg"],
  });
  r.check(
    "a read-only bind on the data directory is refused",
    res.status === 400,
    `${res.status} ${JSON.stringify(res.body)}`
  );

  res = await put({
    mounts: [
      { id: "cfg", source: EXTRA, target: "/etc", enabled: true, readOnly: false },
      { id: "dat", source: DATA, target: "/data", enabled: false, readOnly: false },
    ],
    adopt: ["cfg"],
    releaseData: ["dat"],
  });
  r.check("acknowledged, it goes through", res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);
  detail = await waitForPhase(api, serviceId, ["done", "failed"]);
  r.check("and completes", detail.mountApply.phase === "done", JSON.stringify(detail.mountApply.error));

  await sleep(2000);
  r.check(
    "the service is back on the managed volume",
    (detail.containerMounts ?? []).some((m) => m.source.startsWith("runpanel-redis-") && m.target === "/data"),
    JSON.stringify(detail.containerMounts)
  );
  r.check(
    "with the older data, exactly as the refusal said",
    !redisCli(container, "GET", "dopo-lo-spostamento").includes("solo-nel-bind"),
    redisCli(container, "GET", "dopo-lo-spostamento")
  );

  await api.call(`/api/services/${serviceId}?deleteData=true`, { method: "DELETE" });
  scrub();
  return r.result();
}
