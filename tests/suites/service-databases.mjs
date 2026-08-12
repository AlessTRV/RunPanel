import { client, createReporter, docker, sleep, SETUP_TOKEN } from "../harness.mjs";

/**
 * Many databases inside one service.
 *
 * A service is a database server, and a second database used to mean a second
 * container: a gigabyte of RAM spent expressing something the engine already
 * models. These assertions check the panel and the engine agree — a name that
 * exists here but not in Postgres is worse than no feature at all.
 */
export const meta = { name: "service-databases", needsDocker: true, drivers: ["sqlite"] };

/**
 * The container needs a moment after `docker run` before it answers queries —
 * and on first boot it restarts once, after initdb, so "ready" has to be
 * observed rather than assumed from `docker run` returning.
 */
async function waitForPostgres(container, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (docker("exec", container, "pg_isready").includes("accepting connections")) return true;
    await sleep(1000);
  }
  return false;
}

export async function run({ base }) {
  const r = createReporter("service-databases");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "service-databases-pw" }),
  });

  const created = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({
      name: "dbtest",
      type: "postgresql",
      version: "16",
      port: 55495,
      credentials: { user: "runpanel", password: "probe-pw", database: "primary_db" },
    }),
  });

  r.check("standalone postgres provisioned", created.status === 201,
    `${created.status} ${JSON.stringify(created.body).slice(0, 140)}`);
  if (created.status !== 201) return r.result();

  const serviceId = created.body.id;
  const container = created.body.container_name;

  try {
    const ready = await waitForPostgres(container);
    r.check("the engine accepts connections", ready);

    const listed = await api.call(`/api/services/${serviceId}/databases`);
    r.check("the type supports named databases", listed.body?.supported === true);
    r.check("the primary database is listed and marked",
      listed.body?.databases?.some((d) => d.name === "primary_db" && d.primary),
      JSON.stringify(listed.body?.databases));

    const madeOne = await api.call(`/api/services/${serviceId}/databases`, {
      method: "POST",
      body: JSON.stringify({ name: "staging" }),
    });
    r.check("a database is created", madeOne.status === 201, `${madeOne.status} ${JSON.stringify(madeOne.body)}`);

    await api.call(`/api/services/${serviceId}/databases`, {
      method: "POST",
      body: JSON.stringify({ name: "analytics" }),
    });

    // The engine is the authority: the panel claiming a database that psql
    // cannot see is the failure this whole feature has to avoid.
    const inEngine = docker(
      "exec", "-e", "PGPASSWORD=probe-pw", container,
      "psql", "-U", "runpanel", "-d", "postgres", "-Atc",
      "SELECT datname FROM pg_database WHERE NOT datistemplate"
    ).split("\n").map((s) => s.trim());

    r.check("postgres really has both", inEngine.includes("staging") && inEngine.includes("analytics"),
      inEngine.join(","));

    const after = await api.call(`/api/services/${serviceId}/databases`);
    const names = (after.body?.databases ?? []).map((d) => d.name);
    r.check("the listing reports three", names.length === 3, names.join(","));
    r.check("they are marked as the panel's own",
      (after.body?.databases ?? []).filter((d) => d.managed).length === 2,
      JSON.stringify(after.body?.databases));

    const dup = await api.call(`/api/services/${serviceId}/databases`, {
      method: "POST",
      body: JSON.stringify({ name: "staging" }),
    });
    r.check("a duplicate name is refused", dup.status === 409, `${dup.status}`);

    const bad = await api.call(`/api/services/${serviceId}/databases`, {
      method: "POST",
      body: JSON.stringify({ name: 'x"; DROP DATABASE "primary_db' }),
    });
    r.check("a name that is not an identifier is refused", bad.status === 400, `${bad.status}`);
    r.check("and the primary database survived it", inEngine.includes("primary_db"));

    const dropPrimary = await api.call(
      `/api/services/${serviceId}/databases/primary_db`, { method: "DELETE" }
    );
    r.check("the primary database cannot be dropped", dropPrimary.status === 400, `${dropPrimary.status}`);

    const dropped = await api.call(
      `/api/services/${serviceId}/databases/staging`, { method: "DELETE" }
    );
    r.check("a database is dropped", dropped.status === 200, `${dropped.status} ${JSON.stringify(dropped.body)}`);

    const remaining = docker(
      "exec", "-e", "PGPASSWORD=probe-pw", container,
      "psql", "-U", "runpanel", "-d", "postgres", "-Atc",
      "SELECT datname FROM pg_database WHERE NOT datistemplate"
    ).split("\n").map((s) => s.trim());

    r.check("it is gone from the engine", !remaining.includes("staging"), remaining.join(","));
    r.check("the others are untouched",
      remaining.includes("analytics") && remaining.includes("primary_db"), remaining.join(","));

    // Redis has numbered databases and no names; the API must say so rather
    // than offer a form that cannot work.
    const redis = await api.call("/api/services", {
      method: "POST",
      body: JSON.stringify({ name: "cachetest", type: "redis", version: "7", port: 55496 }),
    });
    if (redis.status === 201) {
      const redisDbs = await api.call(`/api/services/${redis.body.id}/databases`);
      r.check("redis reports no named databases", redisDbs.body?.supported === false,
        JSON.stringify(redisDbs.body));
      await api.call(`/api/services/${redis.body.id}?deleteData=true`, { method: "DELETE" });
    }
  } finally {
    await api.call(`/api/services/${serviceId}?deleteData=true`, { method: "DELETE" });
    docker("rm", "-f", "runpanel-svc-dbtest", "runpanel-svc-cachetest");
    docker("volume", "rm", "runpanel-pg-dbtest", "runpanel-redis-cachetest");
  }

  return r.result();
}
