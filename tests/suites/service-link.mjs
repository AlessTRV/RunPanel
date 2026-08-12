import { client, createReporter, docker, SETUP_TOKEN } from "../harness.mjs";

/**
 * Attaching, detaching and switching a database link — over HTTP.
 *
 * `service-link-unit` covers the rule that decides what an app receives. This
 * covers the surface that sets it, which did not exist until now: `project_id`
 * was written once at creation and there was no PATCH, so the only way to
 * detach a database from a project was to delete the service — and deleting a
 * service is a dialog about destroying its data.
 *
 * Needs Docker because a service is a real container: the panel provisions it
 * on create and moves it between networks on link changes, and a test that
 * faked that would not be testing the part most likely to break.
 */
export const meta = { name: "service-link", needsDocker: true, drivers: ["sqlite"] };

export async function run({ base }) {
  const r = createReporter("service-link");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, setupToken: SETUP_TOKEN, password: "service-link-pw" }),
  });

  const project = await api.call("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Link Suite" }),
  });
  const projectId = project.body.id;

  const created = await api.call("/api/services", {
    method: "POST",
    body: JSON.stringify({
      name: "main",
      type: "postgresql",
      version: "16",
      port: 55496,
      projectId,
      credentials: { user: "runpanel", password: "link-pw", database: "main_db" },
    }),
  });
  r.check("a database is created inside the project", created.status === 201,
    `${created.status} ${JSON.stringify(created.body).slice(0, 140)}`);
  if (created.status !== 201) return r.result();

  const serviceId = created.body.id;

  try {
    // --- a new link starts on ------------------------------------------------
    r.check("a new link injects by default", created.body.inject_env === 1, String(created.body.inject_env));
    r.check("and takes the type's key", created.body.env_key === null, String(created.body.env_key));

    const detail = await api.call(`/api/services/${serviceId}`);
    r.check("the detail view resolves the key", detail.body.envKey === "DATABASE_URL", String(detail.body.envKey));
    r.check("and reports the switch", detail.body.injectEnv === true, String(detail.body.injectEnv));

    // --- the switch ----------------------------------------------------------
    const off = await api.call(`/api/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ injectEnv: false }),
    });
    r.check("the switch can be turned off", off.status === 200, `${off.status} ${JSON.stringify(off.body).slice(0, 120)}`);

    const afterOff = await api.call(`/api/services/${serviceId}`);
    r.check("and the change is readable back", afterOff.body.injectEnv === false);

    await api.call(`/api/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ injectEnv: true }),
    });
    r.check("and turned on again", (await api.call(`/api/services/${serviceId}`)).body.injectEnv === true);

    // --- two databases of the same type --------------------------------------
    const second = await api.call("/api/services", {
      method: "POST",
      body: JSON.stringify({
        name: "analytics",
        type: "postgresql",
        version: "16",
        port: 55497,
        projectId,
        credentials: { user: "runpanel", password: "link-pw", database: "analytics_db" },
      }),
    });
    r.check("a second database of the same type is accepted", second.status === 201, String(second.status));

    if (second.status === 201) {
      // The whole point: it used to be accepted and then silently ignored,
      // because both resolved to DATABASE_URL and the loop kept the first.
      r.check(
        "and is given a key of its own instead of colliding",
        second.body.env_key === "ANALYTICS_DATABASE_URL",
        String(second.body.env_key)
      );

      const collide = await api.call(`/api/services/${second.body.id}`, {
        method: "PATCH",
        body: JSON.stringify({ envKey: "DATABASE_URL" }),
      });
      r.check("moving it onto the taken key is refused", collide.status === 409, String(collide.status));
      r.check("the refusal names the other service", String(collide.body.error).includes("main"), String(collide.body.error));
      r.check("and offers a way out", typeof collide.body.suggestedEnvKey === "string", JSON.stringify(collide.body));

      // Freeing the key makes the same request legal — the constraint is about
      // two live injections, not about the name being reserved forever.
      await api.call(`/api/services/${serviceId}`, {
        method: "PATCH",
        body: JSON.stringify({ injectEnv: false }),
      });
      const nowFree = await api.call(`/api/services/${second.body.id}`, {
        method: "PATCH",
        body: JSON.stringify({ envKey: "DATABASE_URL" }),
      });
      r.check("once the first link is off, the key is free", nowFree.status === 200, String(nowFree.status));

      await api.call(`/api/services/${second.body.id}?deleteData=true`, { method: "DELETE" });
    }

    // --- a bad key is refused before it reaches the database -------------------
    for (const [label, envKey] of [
      ["lowercase", "database_url"],
      ["leading digit", "2_URL"],
      ["with a dash", "DATABASE-URL"],
    ]) {
      const bad = await api.call(`/api/services/${serviceId}`, {
        method: "PATCH",
        body: JSON.stringify({ envKey }),
      });
      r.check(`an invalid key is refused: ${label}`, bad.status === 400, `${envKey} → ${bad.status}`);
    }

    // --- detaching ------------------------------------------------------------
    const detached = await api.call(`/api/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId: null }),
    });
    r.check("a service can be detached", detached.status === 200, String(detached.status));

    const afterDetach = await api.call(`/api/services/${serviceId}`);
    r.check("it no longer belongs to the project", afterDetach.body.project_id === null);
    r.check("detaching also stops the injection", afterDetach.body.injectEnv === false);

    // The container survives: detaching is a link change, not a deletion. This
    // is the whole reason the endpoint exists.
    const stillRunning = docker("inspect", created.body.container_name, "--format", "{{.State.Running}}");
    r.check("and the container is still up", stillRunning === "true", stillRunning || "(assente)");

    // --- reattaching ----------------------------------------------------------
    const reattached = await api.call(`/api/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId }),
    });
    r.check("and it can be attached again", reattached.status === 200, String(reattached.status));
    r.check("with the injection back on", (await api.call(`/api/services/${serviceId}`)).body.injectEnv === true);

    const missing = await api.call(`/api/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId: "does-not-exist" }),
    });
    r.check("attaching to a project that is not there is a 404", missing.status === 404, String(missing.status));

    // --- and none of it without a session -------------------------------------
    const stranger = await client(base).call(`/api/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ injectEnv: false }),
    });
    r.check("PATCH requires a session", stranger.status === 401, String(stranger.status));
  } finally {
    await api.call(`/api/services/${serviceId}?deleteData=true`, { method: "DELETE" });
    await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  }

  return r.result();
}
